import { chromium, Locator, Page } from "playwright";
import { format, addDays, isValid as isValidDate } from "date-fns";
import { log, loadBookings, saveBookings, BookingStatus, getFormattedDate, parseDate, getDay } from "./util";

const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;
const WAYLEADR_URL = "https://app.wayleadr.com/users/sign_in";

const S = {
  emailInput: "#user_email",
  passwordInput: "#user_password",
  signInButton: 'input[type="submit"][value="Sign In"], button:has-text("Sign In")',
  postLoginBookingPageIndicator: 'label:has-text("Dates"), label:has-text("Preferred Zone")',
  bookSpaceButton: 'a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)',
  preBookTab: 'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")',
  dateInput: "input#booking_request_date_range.hasDatepicker",
  calendarContainer: "div#ui-datepicker-div",
  calendarTable: "table.ui-datepicker-calendar",
  dayCell: (dayToSelect: string) =>
    `td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default[data-date="${dayToSelect}"]`,
  noSpacesMessage: 'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")',
  submitButton: 'input#form-submit-button[value="Request Space"]',
  successAlert: 'div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")',
  errorAlert: 'div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")',
};

async function clickWhenReady(locator: Locator, timeout = 10000) {
  await locator.waitFor({ state: "visible", timeout });
  await locator.click({ timeout });
}

async function updateBookingStatus(
  date: Date,
  outcome: BookingStatus,
  message?: string
): Promise<void> {
  const bookings = await loadBookings(); 
  const dateStrToUpdate = getFormattedDate(date);

  let found = false;
  for (const booking of bookings) {
    if (booking.parking_date === dateStrToUpdate) {
      booking.status = outcome;
      booking.last_attempt = getFormattedDate(new Date());
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
    const bookingDateObj = parseDate(b.parking_date);
    if (!isValidDate(bookingDateObj)) {
      log("WARNING", `Invalid date found in bookings.json during filter: ${b.parking_date}`);
      return false;
    }
    bookingDateObj.setHours(0,0,0,0);

    const isRecent = bookingDateObj >= sevenDaysAgo;
    const isPending = b.status === "pending";
    const isFutureOrTodayNoSpaces = b.status === "no_spaces" && bookingDateObj >= today;
    const isRelevantBooked = b.status === "booked" && bookingDateObj >= sevenDaysAgo;
    const isRecentFailed = b.status === "failed" && isRecent;

    return isPending || isFutureOrTodayNoSpaces || isRelevantBooked || isRecentFailed;
  });

  await saveBookings(filteredBookings);
}

async function loginToWayleadr(page: Page): Promise<boolean> {
  try {
    log("INFO", "Navigating to Wayleadr login page...");
    await page.goto(WAYLEADR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000, 
    });

    await page.waitForSelector(S.emailInput, { timeout: 30000 });
    await page.fill(S.emailInput, USERNAME!);
    await page.fill(S.passwordInput, PASSWORD!);

    const loginButtonLocator = page.locator(S.signInButton);
    await loginButtonLocator.waitFor({ state: "visible", timeout: 20000 });

    log("INFO", "Attempting to sign in...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      loginButtonLocator.click({ timeout: 20000 }),
    ]);
    log("INFO", `Current URL after login attempt: ${page.url()}`);

    if (
      !page.url().includes("/request_space") &&
      !page.url().includes("/request/new") &&
      !page.url().includes("/dashboard")
    ) {
        log("INFO", 'Not on booking page, attempting to click "Book Space" link/button...');
        const bookSpaceButtonLocator = page.locator(S.bookSpaceButton);
        try {
            await bookSpaceButtonLocator.waitFor({ state: "visible", timeout: 20000 });
            log("INFO", 'Found "Book Space" button, clicking...');
            await Promise.all([
            page.waitForURL(/(\/request_space|\/request\/new)/, {
                timeout: 30000,
                waitUntil: "domcontentloaded",
            }),
            bookSpaceButtonLocator.click({ timeout: 15000 }),
            ]);
            log("INFO", 'Navigated to booking form via "Book Space" button.');
        } catch (e: any) {
            log("WARNING", `"Book Space" button not found or failed to navigate: ${e.message}. Checking for booking form elements directly.`);
        }
    }

    await page.waitForSelector(S.postLoginBookingPageIndicator, { timeout: 30000 });
    log("INFO", "Successfully navigated to the booking page or a page with booking elements.");
    return true;
  } catch (error: any) {
    log("ERROR", `Login or navigation to booking page failed: ${error.message}`);
    return false;
  }
}

async function bookParkingSpace(page: Page, date: Date): Promise<BookingStatus> {
  const fullDateForLog = getFormattedDate(date);
  log("INFO", `Attempting to book parking for date: ${fullDateForLog}`);

  try {
    const preBookTab = page.locator(S.preBookTab);
    if (await preBookTab.count() > 0) {
      const preBookTabElement = preBookTab.first();
      const isActive = await preBookTabElement.evaluate(
        (el) => el.classList.contains("active") || el.getAttribute("aria-selected") === "true"
      );
      if (!isActive) {
        log("INFO", "Pre-Book Space tab found and is not active. Clicking it.");
        await preBookTabElement.click();
        await page.waitForTimeout(1500);
      } 
    }

    await clickWhenReady(page.locator(S.dateInput));
    await clickWhenReady(page.locator(S.calendarContainer));

    const day = getDay(date);
    await clickWhenReady(page.locator(S.calendarTable).locator(S.dayCell(day)));
    if (await page.locator(S.noSpacesMessage).isVisible({ timeout: 3000 }).catch(() => false)) {
      return "no_spaces";
    }

    const submitButton = page.locator(S.submitButton);
    await submitButton.waitFor({ state: "visible", timeout: 15000 });
    log("INFO", "Submitting booking request...");
    await submitButton.click({ timeout: 30000 });
    await page.waitForFunction(
      (selectors) => selectors.some((selector) => !!document.querySelector(selector)),
      [
        S.successAlert, 
        S.errorAlert,
        S.noSpacesMessage,
      ],
      { timeout: 20000 }
    );

    if (await page.locator(S.successAlert).isVisible().catch(() => false)) return "booked";
    if (await page.locator(S.noSpacesMessage).isVisible().catch(() => false)) return "no_spaces";
    if (await page.locator(S.errorAlert).isVisible().catch(() => false)) return "failed";
    return "failed";
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
      const targetParkingDate = parseDate(booking.parking_date);
      if (!isValidDate(targetParkingDate)) {
        log("WARNING", `Invalid date in bookings.json: ${booking.parking_date}. Skipping.`);
        continue;
      }
      targetParkingDate.setHours(0, 0, 0, 0);

      const dayToMakeBooking = addDays(targetParkingDate, -1);
      dayToMakeBooking.setHours(0,0,0,0);

      if (today.getTime() === dayToMakeBooking.getTime()) {
        bookingsToAttempt.push(targetParkingDate);
      }
    }
  }

  if (bookingsToAttempt.length === 0) {
    log("INFO", "No pending bookings scheduled for execution today.");
    return;
  }

  log("INFO", `Found ${bookingsToAttempt.length} booking(s) to attempt: ${bookingsToAttempt.map((d) => getFormattedDate(d)).join(", ")}`);

  const browser = await chromium.launch({
    headless: process.env.NODE_ENV === "production",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-extensions",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });

  const page = await context.newPage();

  try {
    if (await loginToWayleadr(page)) {
      for (const dateToBook of bookingsToAttempt) {
        const result = await bookParkingSpace(page, dateToBook);
        await updateBookingStatus(
          dateToBook,
          result,
          `Attempted on ${getFormattedDate(new Date())}. Result: ${result}`
        );

        if (result !== "booked") {
          log("INFO", `Pausing briefly after non-successful attempt for ${getFormattedDate(dateToBook)}.`);
          await page.waitForTimeout(2000 + Math.random() * 1000);
        }
      }
    } else {
      log("ERROR", "Login failed. No bookings will be attempted for today's scheduled dates.");
      for (const dateToBook of bookingsToAttempt) {
        await updateBookingStatus(
          dateToBook,
          "failed",
          `Login failed on ${getFormattedDate(new Date())}. Booking not attempted.`
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
    if (browser.isConnected()) {
        await context.close();
        await browser.close();
    }
  }
}

main().catch((error) => {
  log("ERROR", `Unhandled error at top level: ${error.message} \n ${error.stack}`);
  process.exit(1);
});
