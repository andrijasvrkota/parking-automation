import { chromium, Browser, Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import { format, addDays, parse, isValid as isValidDate } from "date-fns"; // Removed isBefore as it wasn't used in the simplified filter
import { Booking, TARGET_DATE_FORMAT } from "./types";

const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json");
const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;

function log(level: "INFO" | "ERROR" | "WARNING", message: string): void {
  const timestamp = format(new Date(), TARGET_DATE_FORMAT);
  console.log(`${timestamp} - ${level}: ${message}`);
}

async function loadBookings(): Promise<Booking[]> {
  try {
    const data = await fs.readFile(BOOKINGS_FILE, "utf8");
    const bookings = JSON.parse(data) as Booking[];
    return bookings.filter((b) => b.parking_date && b.status && b.created_at);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      log("INFO", `Bookings file not found at ${BOOKINGS_FILE}. Returning empty array.`);
      return [];
    }
    log("ERROR", `Failed to load bookings: ${error.message}`);
    return [];
  }
}

async function saveBookings(bookings: Booking[]): Promise<void> {
  try {
    await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  } catch (error: any) {
    log("ERROR", `Failed to save bookings: ${error.message}`);
  }
}

async function updateBookingStatus(
  date: Date,
  outcome: "booked" | "failed" | "no_spaces",
  message?: string
): Promise<void> {
  const bookings = await loadBookings();
  const dateStrToUpdate = format(date, TARGET_DATE_FORMAT);

  let found = false;
  for (const booking of bookings) {
    if (booking.parking_date === dateStrToUpdate) {
      booking.status = outcome;
      booking.last_attempt = format(new Date(), TARGET_DATE_FORMAT)
      if (message) {
        booking.attempt_message = message;
      }
      found = true;
      break;
    }
  }
  if (!found) {
    log("WARNING", `Could not find booking for date ${dateStrToUpdate} to update status.`);
  }

  const sevenDaysAgo = addDays(new Date(), -7);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const filteredBookings = bookings.filter((b) => {
    const bookingDateObj = parse(
      b.parking_date,
      TARGET_DATE_FORMAT,
      new Date()
    );
    if (!isValidDate(bookingDateObj)) {
      return false;
    }

    const isRecent = bookingDateObj >= sevenDaysAgo;
    const isPending = b.status === "pending";
    const isFutureNoSpaces = b.status === "no_spaces" && bookingDateObj >= today;
    const isRelevantBooked = b.status === "booked" && bookingDateObj >= sevenDaysAgo;

    return (
      isPending ||
      isFutureNoSpaces ||
      isRelevantBooked ||
      (isRecent &&
        b.status !== "pending" &&
        b.status !== "no_spaces" &&
        b.status !== "booked")
    );
  });

  await saveBookings(filteredBookings);
}

async function loginToWayleadr(page: Page): Promise<boolean> {
  try {
    log("INFO", "Navigating to Wayleadr login page...");
    await page.goto("https://app.wayleadr.com/users/sign_in", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForSelector("#user_email", { timeout: 30000 });
    await page.fill("#user_email", USERNAME!);
    await page.fill("#user_password", PASSWORD!);

    const loginButtonLocator = page.locator(
      'input[type="submit"][value="Sign In"], button:has-text("Sign In")'
    );
    await loginButtonLocator.waitFor({ state: "visible", timeout: 20000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      loginButtonLocator.click({ timeout: 20000 }),
    ]);

    if (
      !page.url().includes("/request_space") &&
      !page.url().includes("/request/new")
    ) {
      log(
        "INFO",
        'Not on booking page, attempting to click "Book Space" link/button...'
      );
      const bookSpaceButtonLocator = page.locator(
        'a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)'
      );
      try {
        await bookSpaceButtonLocator.waitFor({
          state: "visible",
          timeout: 20000,
        });
        await Promise.all([
          page.waitForURL(/(\/request_space|\/request\/new)/, {
            timeout: 30000,
            waitUntil: "domcontentloaded",
          }),
          bookSpaceButtonLocator.click({ timeout: 15000 }),
        ]);
        log("INFO", 'Navigated to booking form via "Book Space" button.');
      } catch (e: any) {
        log(
          "WARNING",
          `"Book Space" button not found or failed to navigate: ${e.message}. Proceeding.`
        );
      }
    }

    await page.waitForSelector(
      'label:has-text("Dates"), label:has-text("Preferred Zone")',
      { timeout: 20000 }
    );
    log("INFO", "Successfully navigated to the booking page.");
    return true;
  } catch (error: any) {
    log("ERROR", `Login or navigation to booking page failed: ${error.message}`);
    return false;
  }
}

async function bookParkingSpace(page: Page, parkingDateForForm: Date): Promise<"booked" | "failed" | "no_spaces"> {
  const dayToSelect = format(parkingDateForForm, "d");
  const fullDateForLog = format(parkingDateForForm, TARGET_DATE_FORMAT);

  log("INFO", `Attempting to book parking for: ${fullDateForLog}`);

  try {
    await page.waitForTimeout(1000);

    const preBookTabSelector =
      'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")';
    const preBookTab = page.locator(preBookTabSelector);
    if (
      (await preBookTab.count()) > 0 &&
      (await preBookTab.first().isVisible({ timeout: 7000 }))
    ) {
      const preBookTabElement = preBookTab.first();
      const isActive = await preBookTabElement.evaluate(
        (node) =>
          node.classList.contains("active") ||
          node.getAttribute("aria-selected") === "true"
      );
      if (!isActive) {
        await preBookTabElement.click();
        await page.waitForTimeout(1500);
      }
    }

    const dateInputActivator = page.locator(
      "input#booking_request_date_range.hasDatepicker"
    );
    await dateInputActivator.waitFor({ state: "visible", timeout: 10000 });
    await dateInputActivator.scrollIntoViewIfNeeded();
    await dateInputActivator.click({ force: true, timeout: 7000 });

    const calendarContainerLocator = page.locator("div#ui-datepicker-div");
    await calendarContainerLocator.waitFor({
      state: "visible",
      timeout: 15000,
    });
    const calendarTableLocator = calendarContainerLocator.locator(
      "table.ui-datepicker-calendar"
    );
    await calendarTableLocator.waitFor({ state: "visible", timeout: 5000 });

    const dayCellLinkLocator = calendarTableLocator.locator(
      `td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default[data-date="${dayToSelect}"]`
    );
    await dayCellLinkLocator.waitFor({ state: "visible", timeout: 10000 });
    await dayCellLinkLocator.click();
    await page.waitForTimeout(1000);

    const noSpacesMessageLocator = page.locator(
      'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")'
    );
    if (
      (await noSpacesMessageLocator.count()) > 0 &&
      (await noSpacesMessageLocator.first().isVisible({ timeout: 3000 }))
    ) {
      const messageText = await noSpacesMessageLocator.first().textContent();
      log(
        "WARNING",
        `No spaces available for ${fullDateForLog} (pre-submit check): ${messageText?.trim()}`
      );
      return "no_spaces";
    }

    const requestSpaceButton = page.locator(
      'input#form-submit-button[value="Request Space"]'
    );
    await requestSpaceButton.waitFor({ state: "visible", timeout: 15000 });
    await requestSpaceButton.click({ timeout: 30000 });

    const successAlertLocator = page.locator(
      'div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")'
    );
    const errorAlertLocator = page.locator(
      'div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")'
    );

    try {
      await page.waitForFunction(
        (selectors) =>
          selectors.some((selector) => !!document.querySelector(selector)),
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
        log("INFO", `Booking successful for ${fullDateForLog}! Message: ${successMsg?.trim()}`);
        return "booked";
      } else if (
        (await noSpacesMessageLocator.count()) > 0 &&
        (await noSpacesMessageLocator.first().isVisible())
      ) {
        const messageText = await noSpacesMessageLocator.first().textContent();
        log("WARNING", `No spaces available for ${fullDateForLog} (post-submit check): ${messageText?.trim()}`);
        return "no_spaces";
      } else if (
        (await errorAlertLocator.count()) > 0 &&
        (await errorAlertLocator.first().isVisible())
      ) {
        const errorMsg = await errorAlertLocator.first().textContent();
        log("ERROR", `Booking failed for ${fullDateForLog}. Message: ${errorMsg?.trim()}`);
        return "failed";
      } else {
        log("WARNING", `Booking for ${fullDateForLog} submitted, but outcome unclear. Assuming failure.`);
        return "failed";
      }
    } catch (e: any) {
      log("ERROR", `Timeout or error waiting for booking confirmation for ${fullDateForLog}: ${e.message}`);
      return "failed";
    }
  } catch (error: any) {
    log("ERROR", `General error during booking process for ${fullDateForLog}: ${error.message}`);
    return "failed";
  }
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log("ERROR", "Credentials (WAYLEADR_USERNAME, WAYLEADR_PASSWORD) are not set.");
    process.exit(1);
  }

  const allBookings = await loadBookings();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bookingsToAttempt: Date[] = [];
  for (const booking of allBookings) {
    if (booking.status === "pending") {
      const targetParkingDate = parse(
        booking.parking_date,
        TARGET_DATE_FORMAT,
        new Date()
      );
      if (!isValidDate(targetParkingDate)) {
        log("WARNING", `Invalid date in bookings.json: ${booking.parking_date}. Skipping.`);
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
    log("INFO", "No pending bookings scheduled for execution today.");
    return;
  }

  log("INFO", `Found ${bookingsToAttempt.length} booking(s) to attempt: 
    ${bookingsToAttempt
      .map((d) => format(d, TARGET_DATE_FORMAT))
      .join(", ")}`
  );

  const browser = await chromium.launch({
    headless: process.env.NODE_ENV === "production",
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
        const result = await bookParkingSpace(page, dateToBook);
        await updateBookingStatus(
          dateToBook,
          result,
          `Attempted on ${format(new Date(), TARGET_DATE_FORMAT)}`
        );
        if (result !== "booked") {
          log("INFO", `Pausing after non-successful attempt for ${format(dateToBook, TARGET_DATE_FORMAT)}.`);
          await page.waitForTimeout(2000);
        }
      }
    } else {
      log("ERROR", "Login failed. No bookings will be attempted.");
      for (const dateToBook of bookingsToAttempt) {
        await updateBookingStatus(
          dateToBook,
          "failed",
          `Login failed on ${format(new Date(), TARGET_DATE_FORMAT)}`
        );
      }
    }
  } catch (error: any) {
    log("ERROR", `Unhandled error in main execution: ${error.message}`);
    for (const dateToBook of bookingsToAttempt) {
      await updateBookingStatus(dateToBook, "failed", `Unhandled script error: ${error.message}`);
    }
  } finally {
    log("INFO", "Closing browser.");
    await browser.close();
  }
}

main().catch((error) => {
  log("ERROR", `Unhandled error at top level: ${error.message}`);
  process.exit(1);
});
