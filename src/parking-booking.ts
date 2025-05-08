import { chromium, Browser, Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { format, addDays, parseISO, isValid as isValidDate } from "date-fns";

// --- Configuration ---
const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json"); // Adjusted path for src/dist structure
const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;
const VEHICLE_ID = process.env.VEHICLE_ID; // This should be the visible text in the dropdown

// --- Interfaces ---
interface Booking {
  parking_date: string; //<y_bin_46>-MM-DD
  status: "pending" | "booked" | "failed" | "no_spaces";
  created_at: string; // ISO Date string
  last_attempt: string | null; // ISO Date string
  attempt_message?: string; // Optional message from the booking attempt
}

// --- Logging ---
function logger(level: "INFO" | "ERROR" | "WARNING", message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${level}: ${message}`);
}

// --- File Operations ---
async function loadBookings(): Promise<Booking[]> {
  try {
    const data = await fs.readFile(BOOKINGS_FILE, "utf8");
    const bookings = JSON.parse(data) as Booking[];
    return bookings.filter((b) => b.parking_date && b.status && b.created_at);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      logger(
        "INFO",
        `Bookings file not found at ${BOOKINGS_FILE}. Returning empty array.`
      );
      return [];
    }
    logger("ERROR", `Failed to load bookings: ${error.message}`);
    return [];
  }
}

async function saveBookings(bookings: Booking[]): Promise<void> {
  try {
    await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
    logger("INFO", `Bookings saved to ${BOOKINGS_FILE}`);
  } catch (error: any) {
    logger("ERROR", `Failed to save bookings: ${error.message}`);
  }
}

async function updateBookingStatus(
  parkingDateToUpdate: Date,
  outcome: "booked" | "failed" | "no_spaces",
  message?: string
): Promise<void> {
  const bookings = await loadBookings();
  const dateStrToUpdate = format(parkingDateToUpdate, "yyyy-MM-dd");

  let found = false;
  for (const booking of bookings) {
    if (booking.parking_date === dateStrToUpdate) {
      booking.status = outcome;
      booking.last_attempt = new Date().toISOString();
      if (message) {
        booking.attempt_message = message;
      }
      found = true;
      break;
    }
  }
  if (!found) {
    logger(
      "WARNING",
      `Could not find booking for date ${dateStrToUpdate} to update status.`
    );
  }

  const sevenDaysAgo = addDays(new Date(), -7);
  const filteredBookings = bookings.filter((b) => {
    const bookingDateObj = parseISO(b.parking_date);
    if (!isValidDate(bookingDateObj)) return false;
    return (
      bookingDateObj >= sevenDaysAgo ||
      b.status === "pending" ||
      (b.status === "no_spaces" && bookingDateObj >= new Date())
    );
  });

  await saveBookings(filteredBookings);
}

// --- Playwright Actions ---
async function loginToWayleadr(page: Page): Promise<boolean> {
  try {
    logger("INFO", "Navigating to Wayleadr login page...");
    await page.goto("https://app.wayleadr.com/users/sign_in", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    logger("INFO", "Waiting for login form elements...");
    await page.waitForSelector("#user_email", { timeout: 30000 });
    await page.waitForSelector("#user_password", { timeout: 10000 });

    logger("INFO", "Entering login credentials...");
    await page.fill("#user_email", USERNAME!);
    await page.fill("#user_password", PASSWORD!);

    logger("INFO", "Locating login button (Sign In)...");
    const loginButtonLocator = page.locator(
      'input[type="submit"][value="Sign In"], button:has-text("Sign In")'
    );

    logger("INFO", "Waiting for login button to be visible...");
    await loginButtonLocator.waitFor({ state: "visible", timeout: 20000 });

    logger("INFO", "Scrolling login button into view...");
    await loginButtonLocator.scrollIntoViewIfNeeded();

    logger("INFO", "Clicking login button...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      loginButtonLocator.click({ timeout: 20000 }),
    ]);
    logger("INFO", "Login click initiated, navigation completed.");

    // After login, we might be on a dashboard. We need to find and click the "Book Space" button.
    if (
      !page.url().includes("/request_space") &&
      !page.url().includes("/request/new")
    ) {
      logger(
        "INFO",
        'Not on booking page URL. Looking for "Book Space" button/link...'
      );

      // More specific selector for the "Book Space" button based on its classes and icon
      const bookSpaceButtonLocator = page.locator(
        'a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)'
      );
      // We could also try: page.getByRole('link', { name: /Book Space/i }).filter({ has: page.locator('i.fe-plus.mr-2') });

      logger(
        "INFO",
        `Attempting to find specific "Book Space" button with selector: ${bookSpaceButtonLocator.toString()}`
      );

      // Wait for this specific button to be visible and enabled
      try {
        await bookSpaceButtonLocator.waitFor({
          state: "visible",
          timeout: 20000,
        });
        logger(
          "INFO",
          '"Book Space" button (specific) found and is visible/enabled. Clicking it...'
        );

        await Promise.all([
          page.waitForURL(/(\/request_space|\/request\/new)/, {
            timeout: 30000,
            waitUntil: "domcontentloaded",
          }),
          bookSpaceButtonLocator.click({ timeout: 15000 }),
        ]);
        logger(
          "INFO",
          'Clicked "Book Space" and waited for URL change to booking form.'
        );
      } catch (e: any) {
        logger(
          "WARNING",
          `"Book Space" button (specific) not found or not interactable: ${e.message}. Will check for general booking form elements.`
        );
        // If the specific button click fails, we will fall through to the final verification.
        // This might happen if we are already on the booking page due to a redirect.
      }
    } else {
      logger("INFO", "Already on a URL that looks like the booking page.");
    }

    logger(
      "INFO",
      'Verifying presence of booking form elements (e.g., "Dates" label)...'
    );
    await page.waitForSelector(
      'label:has-text("Dates"), label:has-text("Preferred Zone")',
      { timeout: 20000 }
    );

    logger("INFO", "Successfully navigated to the booking page.");
    return true;
  } catch (error: any) {
    logger(
      "ERROR",
      `Login or navigation to booking page failed: ${error.message}`
    );
    await page.screenshot({
      path: `login_or_nav_error_${Date.now()}.png`,
      fullPage: true,
    });
    return false;
  }
}

async function bookParkingSpace(
  page: Page,
  parkingDateForForm: Date
): Promise<"booked" | "failed" | "no_spaces"> {
  const formattedDateForInput = format(parkingDateForForm, "MM/dd/yyyy");
  logger(
    "INFO",
    `Attempting to book parking for date: ${formattedDateForInput}`
  );

  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });

    logger(
      "INFO",
      'Ensuring "Pre-Book Space" tab is selected (if applicable)...'
    );
    const preBookTabSelector =
      'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")';
    const preBookTab = page.locator(preBookTabSelector);

    if (
      (await preBookTab.count()) > 0 &&
      (await preBookTab.first().isVisible({ timeout: 5000 }))
    ) {
      const preBookTabElement = preBookTab.first();
      const isActive = await preBookTabElement.evaluate(
        (node) =>
          node.classList.contains("active") ||
          node.getAttribute("aria-selected") === "true"
      );
      if (!isActive) {
        logger("INFO", 'Clicking "Pre-Book Space" tab.');
        await preBookTabElement.click();
        await page.waitForTimeout(1500);
      } else {
        logger("INFO", '"Pre-Book Space" tab is already active.');
      }
    } else {
      logger(
        "INFO",
        '"Pre-Book Space" tab not found or not visible. Assuming form is ready.'
      );
    }

    logger("INFO", 'Selecting "Shared Spaces" zone...');
    const zoneDropdown = page.locator(
      'label:has-text("Preferred Zone") ~ div select, label:has-text("Preferred Zone") + select'
    );
    await zoneDropdown.waitFor({ state: "visible", timeout: 10000 });
    await zoneDropdown.selectOption({ label: "Shared Spaces" });
    await page.waitForTimeout(500);

    logger("INFO", `Setting date to ${formattedDateForInput}...`);
    const dateInput = page.locator(
      'label:has-text("Dates") ~ div input[type="text"], label:has-text("Dates") + input[type="text"]'
    );
    await dateInput.waitFor({ state: "visible", timeout: 10000 });
    await dateInput.fill("");
    await dateInput.fill(formattedDateForInput);
    await page.locator("body").click();
    await page.waitForTimeout(500);

    logger("INFO", `Selecting vehicle: ${VEHICLE_ID}...`);
    const vehicleDropdown = page.locator(
      'label:has-text("Vehicle") ~ div select, label:has-text("Vehicle") + select'
    );
    await vehicleDropdown.waitFor({ state: "visible", timeout: 10000 });
    await vehicleDropdown.selectOption({ label: VEHICLE_ID! });
    await page.waitForTimeout(500);

    const noSpacesMessageLocator = page.locator(
      'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")'
    );
    if (
      (await noSpacesMessageLocator.count()) > 0 &&
      (await noSpacesMessageLocator.first().isVisible())
    ) {
      const messageText = await noSpacesMessageLocator.first().textContent();
      logger("WARNING", `No spaces available: ${messageText?.trim()}`);
      await page.screenshot({
        path: `no_spaces_${format(parkingDateForForm, "yyyyMMdd")}.png`,
      });
      return "no_spaces";
    }

    logger("INFO", 'Clicking "Request Space" button...');
    const requestSpaceButton = page.locator(
      'button:has-text("Request Space"):not([disabled])'
    );
    await requestSpaceButton.waitFor({ state: "visible", timeout: 10000 });
    await requestSpaceButton.scrollIntoViewIfNeeded();
    await requestSpaceButton.click();

    const successAlertLocator = page.locator(
      'div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")'
    );
    const errorAlertLocator = page.locator(
      'div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")'
    );

    try {
      await page.waitForFunction(
        (selectors) => {
          return selectors.some(
            (selector) => !!document.querySelector(selector)
          );
        },
        [
          successAlertLocator.first().toString(),
          errorAlertLocator.first().toString(),
          noSpacesMessageLocator.first().toString(),
        ],
        { timeout: 15000 }
      );

      if (
        (await successAlertLocator.count()) > 0 &&
        (await successAlertLocator.first().isVisible())
      ) {
        const successMsg = await successAlertLocator.first().textContent();
        logger("INFO", `Booking successful! Message: ${successMsg?.trim()}`);
        await page.screenshot({
          path: `booking_success_${format(parkingDateForForm, "yyyyMMdd")}.png`,
        });
        return "booked";
      } else if (
        (await noSpacesMessageLocator.count()) > 0 &&
        (await noSpacesMessageLocator.first().isVisible())
      ) {
        const messageText = await noSpacesMessageLocator.first().textContent();
        logger(
          "WARNING",
          `No spaces available after attempting to book: ${messageText?.trim()}`
        );
        await page.screenshot({
          path: `no_spaces_after_click_${format(
            parkingDateForForm,
            "yyyyMMdd"
          )}.png`,
        });
        return "no_spaces";
      } else if (
        (await errorAlertLocator.count()) > 0 &&
        (await errorAlertLocator.first().isVisible())
      ) {
        const errorMsg = await errorAlertLocator.first().textContent();
        logger(
          "ERROR",
          `Booking failed with error message: ${errorMsg?.trim()}`
        );
        await page.screenshot({
          path: `booking_error_alert_${format(
            parkingDateForForm,
            "yyyyMMdd"
          )}.png`,
        });
        return "failed";
      } else {
        logger(
          "WARNING",
          "Booking submitted, but confirmation message not definitively found. Assuming failure for safety."
        );
        await page.screenshot({
          path: `booking_unknown_state_${format(
            parkingDateForForm,
            "yyyyMMdd"
          )}.png`,
        });
        return "failed";
      }
    } catch (e: any) {
      logger(
        "ERROR",
        `Timeout or error waiting for booking confirmation: ${e.message}`
      );
      await page.screenshot({
        path: `booking_timeout_error_${format(
          parkingDateForForm,
          "yyyyMMdd"
        )}.png`,
      });
      return "failed";
    }
  } catch (error: any) {
    logger(
      "ERROR",
      `General error during booking process for ${formattedDateForInput}: ${error.message}`
    );
    await page.screenshot({
      path: `booking_general_error_${format(
        parkingDateForForm,
        "yyyyMMdd"
      )}.png`,
    });
    return "failed";
  }
}

// --- Main Logic ---
async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD || !VEHICLE_ID) {
    logger(
      "ERROR",
      "Credentials (WAYLEADR_USERNAME, WAYLEADR_PASSWORD, VEHICLE_ID) are not set in environment variables."
    );
    process.exit(1);
  }

  const allBookings = await loadBookings();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bookingsToAttempt: Date[] = [];
  for (const booking of allBookings) {
    if (booking.status === "pending") {
      const targetParkingDate = parseISO(booking.parking_date);
      if (!isValidDate(targetParkingDate)) {
        logger(
          "WARNING",
          `Invalid date format in bookings.json: ${booking.parking_date}. Skipping.`
        );
        continue;
      }
      targetParkingDate.setHours(0, 0, 0, 0);

      const dayToMakeBooking = addDays(targetParkingDate, -1);

      if (today.getTime() === dayToMakeBooking.getTime()) {
        bookingsToAttempt.push(targetParkingDate);
      }
    }
  }

  if (bookingsToAttempt.length === 0) {
    logger("INFO", "No pending bookings scheduled for execution today.");
    return;
  }

  logger(
    "INFO",
    `Found ${
      bookingsToAttempt.length
    } booking(s) to attempt today: ${bookingsToAttempt
      .map((d) => format(d, "yyyy-MM-dd"))
      .join(", ")}`
  );

  const browser: Browser = await chromium.launch({
    headless: process.env.NODE_ENV === "production",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    // slowMo: 100 // Uncomment for local debugging to see actions slowly
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
    });
    const page = await context.newPage();

    if (await loginToWayleadr(page)) {
      for (const dateToBook of bookingsToAttempt) {
        const result = await bookParkingSpace(page, dateToBook);
        await updateBookingStatus(
          dateToBook,
          result,
          `Attempted on ${new Date().toISOString()}`
        );
        if (result !== "booked") {
          logger(
            "INFO",
            `Pausing for a moment after a non-successful booking attempt for ${format(
              dateToBook,
              "yyyy-MM-dd"
            )}.`
          );
          await page.waitForTimeout(2000);
        }
      }
    } else {
      logger("ERROR", "Login failed. No bookings will be attempted.");
      for (const dateToBook of bookingsToAttempt) {
        await updateBookingStatus(
          dateToBook,
          "failed",
          `Login failed on ${new Date().toISOString()}`
        );
      }
    }
  } catch (error: any) {
    logger(
      "ERROR",
      `An unhandled error occurred in main execution: ${error.message}`
    );
    for (const dateToBook of bookingsToAttempt) {
      await updateBookingStatus(
        dateToBook,
        "failed",
        `Unhandled script error: ${error.message}`
      );
    }
  } finally {
    logger("INFO", "Closing browser.");
    await browser.close();
  }
}

main().catch((error) => {
  logger("ERROR", `Unhandled error at top level: ${error.message}`);
  process.exit(1);
});
