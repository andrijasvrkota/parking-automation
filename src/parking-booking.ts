import { chromium, Browser, Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { format, addDays, parseISO, isValid as isValidDate } from "date-fns";

// --- Configuration ---
const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json");
const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;

// --- Interfaces ---
interface Booking {
  parking_date: string; //<y_bin_46>-MM-DD
  status: "pending" | "booked" | "failed" | "no_spaces";
  created_at: string; // ISO Date string
  last_attempt: string | null; // ISO Date string
  attempt_message?: string;
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

    if (
      !page.url().includes("/request_space") &&
      !page.url().includes("/request/new")
    ) {
      logger(
        "INFO",
        'Not on booking page URL. Looking for "Book Space" button/link...'
      );

      const bookSpaceButtonLocator = page.locator(
        'a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)'
      );

      logger(
        "INFO",
        `Attempting to find specific "Book Space" button with selector: ${bookSpaceButtonLocator.toString()}`
      );
      try {
        await bookSpaceButtonLocator.waitFor({
          state: "visible",
          timeout: 20000,
        });
        logger(
          "INFO",
          '"Book Space" button (specific) found and is visible. Clicking it...'
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
  const dayToSelect = format(parkingDateForForm, "d");
  const fullDateForLog = format(parkingDateForForm, "yyyy-MM-dd");

  logger("INFO", `Attempting to book parking for date: ${fullDateForLog}`);
  logger("INFO", `Will select day: ${dayToSelect} in the calendar.`);

  try {
    await page.waitForTimeout(1000); // Increased initial pause slightly after navigation

    logger(
      "INFO",
      'Ensuring "Pre-Book Space" tab is selected (if applicable)...'
    );
    const preBookTabSelector =
      'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")';
    const preBookTab = page.locator(preBookTabSelector);

    if (
      (await preBookTab.count()) > 0 &&
      (await preBookTab.first().isVisible({ timeout: 7000 }))
    ) {
      // Increased timeout
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

    // --- Date Selection Logic ---
    logger("INFO", 'Clicking the "Dates" input field to open calendar...');
    const dateInputActivator = page.locator(
      "input#booking_request_date_range.hasDatepicker"
    );
    await dateInputActivator.waitFor({ state: "visible", timeout: 10000 });
    await dateInputActivator.scrollIntoViewIfNeeded();
    await dateInputActivator.click({ force: true, timeout: 7000 }); // Increased timeout

    logger("INFO", "Waiting for calendar to become visible...");
    const calendarContainerLocator = page.locator("div#ui-datepicker-div");
    await calendarContainerLocator.waitFor({
      state: "visible",
      timeout: 15000,
    });
    logger("INFO", "Calendar container (ui-datepicker-div) is visible.");

    const calendarTableLocator = calendarContainerLocator.locator(
      "table.ui-datepicker-calendar"
    );
    await calendarTableLocator.waitFor({ state: "visible", timeout: 5000 });
    logger("INFO", "Calendar table (ui-datepicker-calendar) is visible.");

    logger(
      "INFO",
      `Attempting to select day "${dayToSelect}" in the calendar...`
    );
    const dayCellLinkLocator = calendarTableLocator.locator(
      `td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default[data-date="${dayToSelect}"]`
    );

    await dayCellLinkLocator.waitFor({ state: "visible", timeout: 10000 });
    logger("INFO", `Day cell link for "${dayToSelect}" found. Clicking it.`);
    await dayCellLinkLocator.click();

    await page.waitForTimeout(1000);
    logger("INFO", `Date ${fullDateForLog} should now be selected.`);
    // --- End of Date Selection Logic ---

    // Check for "no available spaces" message BEFORE attempting to click "Request Space"
    // This might appear after date selection if the selected date has no spots.
    const noSpacesMessageLocator = page.locator(
      'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")'
    );
    if (
      (await noSpacesMessageLocator.count()) > 0 &&
      (await noSpacesMessageLocator.first().isVisible({ timeout: 3000 }))
    ) {
      // Quick check
      const messageText = await noSpacesMessageLocator.first().textContent();
      logger(
        "WARNING",
        `No spaces available message detected before final submit: ${messageText?.trim()}`
      );
      await page.screenshot({
        path: `no_spaces_before_submit_${fullDateForLog}.png`,
      });
      return "no_spaces";
    }

    logger(
      "INFO",
      'Locating "Request Space" button (input#form-submit-button)...'
    );
    // Use the specific ID and tag for the submit button
    const requestSpaceButton = page.locator(
      'input#form-submit-button[value="Request Space"]'
    );

    logger("INFO", 'Waiting for "Request Space" button to be visible...');
    await requestSpaceButton.waitFor({ state: "visible", timeout: 15000 }); // Wait for it to be visible

    logger("INFO", 'Scrolling "Request Space" button into view...');
    await requestSpaceButton.scrollIntoViewIfNeeded();

    logger(
      "INFO",
      'Clicking "Request Space" button (will wait for enabled)...'
    );
    // Playwright's click action automatically waits for the element to be enabled.
    // Give it a generous timeout for this enabling process.
    await requestSpaceButton.click({ timeout: 30000 });

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
          path: `booking_success_${fullDateForLog}.png`,
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
          path: `no_spaces_after_click_${fullDateForLog}.png`,
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
          path: `booking_error_alert_${fullDateForLog}.png`,
        });
        return "failed";
      } else {
        logger(
          "WARNING",
          "Booking submitted, but confirmation message not definitively found. Assuming failure for safety."
        );
        await page.screenshot({
          path: `booking_unknown_state_${fullDateForLog}.png`,
        });
        return "failed";
      }
    } catch (e: any) {
      logger(
        "ERROR",
        `Timeout or error waiting for booking confirmation: ${e.message}`
      );
      await page.screenshot({
        path: `booking_timeout_error_${fullDateForLog}.png`,
      });
      return "failed";
    }
  } catch (error: any) {
    logger(
      "ERROR",
      `General error during booking process for ${fullDateForLog}: ${error.message}`
    );
    await page.screenshot({
      path: `booking_general_error_${fullDateForLog}.png`,
    });
    return "failed";
  }
}

// --- Main Logic ---
async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    logger(
      "ERROR",
      "Credentials (WAYLEADR_USERNAME, WAYLEADR_PASSWORD) are not set in environment variables."
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
    // slowMo: 250 // Uncomment for local debugging to see actions slowly
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
