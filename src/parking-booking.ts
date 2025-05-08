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
  parking_date: string; // YYYY-MM-DD
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
    // Validate structure of each booking if necessary
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

  // Remove old successfully booked or failed bookings (older than 7 days)
  const sevenDaysAgo = addDays(new Date(), -7);
  const filteredBookings = bookings.filter((b) => {
    const bookingDateObj = parseISO(b.parking_date);
    if (!isValidDate(bookingDateObj)) return false; // Keep invalid date entries for manual review or filter out
    // Keep if recent OR if status is pending OR if it's a 'no_spaces' for a future date
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
      waitUntil: "networkidle",
    });

    logger("INFO", "Waiting for login form elements...");
    await page.waitForSelector("#user_email", { timeout: 30000 });

    logger("INFO", "Entering login credentials...");
    await page.fill("#user_email", USERNAME!);
    await page.fill("#user_password", PASSWORD!);

    logger("INFO", "Clicking login button...");
    await page.click('input[type="submit"][name="commit"][value="Log in"]'); // More specific selector

    logger("INFO", "Waiting for navigation to dashboard/request space page...");
    // Wait for either a common dashboard element or the "Request Space" page title
    await page.waitForURL(/(\/dashboard|\/request_space)/, {
      timeout: 30000,
      waitUntil: "domcontentloaded",
    });
    // Further check for a specific element that indicates successful login
    await page.waitForSelector(
      'h1:has-text("Request Space"), h1:has-text("Dashboard"), a[href="/request_space"]',
      { timeout: 10000 }
    );

    logger("INFO", "Login successful.");
    return true;
  } catch (error: any) {
    logger("ERROR", `Login failed: ${error.message}`);
    await page.screenshot({ path: "login_error.png", fullPage: true });
    return false;
  }
}

async function bookParkingSpace(
  page: Page,
  parkingDateForForm: Date
): Promise<"booked" | "failed" | "no_spaces"> {
  const formattedDateForInput = format(parkingDateForForm, "MM/dd/yyyy"); // Wayleadr form expects MM/DD/YYYY
  logger(
    "INFO",
    `Attempting to book parking for date: ${formattedDateForInput}`
  );

  try {
    if (!page.url().includes("request_space")) {
      logger("INFO", "Navigating to request space page...");
      await page.goto("https://app.wayleadr.com/request_space", {
        waitUntil: "networkidle",
      });
    } else {
      // Ensure page is fully loaded if already on it
      await page.waitForLoadState("networkidle");
    }

    logger("INFO", 'Ensuring "Pre-Book Space" tab is selected...');
    // The "Pre-Book Space" might be a link or a button-like element.
    // It might already be selected by default.
    const preBookTabSelector =
      'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")';
    // Check if it's already active or click it.
    const preBookTab = page.locator(preBookTabSelector);
    if (await preBookTab.isVisible()) {
      // Check if it's the active tab (often has a specific class or aria-selected attribute)
      const isActive = await preBookTab.evaluate(
        (node) =>
          node.classList.contains("active") ||
          node.getAttribute("aria-selected") === "true"
      );
      if (!isActive) {
        logger("INFO", 'Clicking "Pre-Book Space" tab.');
        await preBookTab.click();
        await page.waitForTimeout(1000); // Wait for tab content to potentially load
      } else {
        logger("INFO", '"Pre-Book Space" tab is already active.');
      }
    } else {
      logger(
        "WARNING",
        '"Pre-Book Space" tab not found. Proceeding with current page state.'
      );
    }

    logger("INFO", 'Selecting "Shared Spaces" zone...');
    // The selector for the zone dropdown needs to be robust.
    // This looks for a select element that is likely the first one for "Preferred Zone".
    // Using a label to find the select is more robust.
    const zoneDropdown = page.locator(
      'label:has-text("Preferred Zone") ~ div select, label:has-text("Preferred Zone") + select'
    );
    await zoneDropdown.selectOption({ label: "Shared Spaces" });
    await page.waitForTimeout(500); // Small pause after selection

    logger("INFO", `Setting date to ${formattedDateForInput}...`);
    // This selector looks for an input field associated with a "Dates" label.
    const dateInput = page.locator(
      'label:has-text("Dates") ~ div input[type="text"], label:has-text("Dates") + input[type="text"]'
    );
    await dateInput.fill(""); // Clear existing date
    await dateInput.fill(formattedDateForInput);
    // Click outside to close date picker if any
    await page.locator("body").click();
    await page.waitForTimeout(500);

    logger("INFO", `Selecting vehicle: ${VEHICLE_ID}...`);
    // This selector looks for a select field associated with a "Vehicle" label.
    const vehicleDropdown = page.locator(
      'label:has-text("Vehicle") ~ div select, label:has-text("Vehicle") + select'
    );
    await vehicleDropdown.selectOption({ label: VEHICLE_ID! }); // Use non-null assertion if sure VEHICLE_ID is set
    await page.waitForTimeout(500);

    // Check for "no available spaces" message BEFORE attempting to click "Request Space"
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
    await requestSpaceButton.scrollIntoViewIfNeeded();
    await requestSpaceButton.click();

    // Wait for confirmation or error
    // Look for a success message. This selector is a guess.
    const successAlertLocator = page.locator(
      'div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")'
    );
    // Look for a general error message if not a "no spaces" message
    const errorAlertLocator = page.locator(
      'div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")'
    );

    try {
      await page.waitForSelector(
        `${successAlertLocator.first().toString()}, ${errorAlertLocator
          .first()
          .toString()}, ${noSpacesMessageLocator.first().toString()}`,
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
        // This case might have been caught before, but double check after click
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
  today.setHours(0, 0, 0, 0); // Normalize to start of day

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
      targetParkingDate.setHours(0, 0, 0, 0); // Normalize

      // Booking should happen the day before the targetParkingDate at 00:00
      const dayToMakeBooking = addDays(targetParkingDate, -1);

      if (today.getTime() === dayToMakeBooking.getTime()) {
        bookingsToAttempt.push(targetParkingDate); // Store the actual date we want to park
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
    headless: process.env.NODE_ENV === "production", // Headless in production (GitHub Actions)
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
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
        const result = await bookParkingSpace(page, dateToBook); // Pass the actual parking date
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
          await page.waitForTimeout(2000); // Small pause if multiple bookings and one fails
        }
      }
    } else {
      logger("ERROR", "Login failed. No bookings will be attempted.");
      // Update status for all bookings that were meant for today if login fails
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
    // Potentially update all pending bookings for today to 'failed'
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
