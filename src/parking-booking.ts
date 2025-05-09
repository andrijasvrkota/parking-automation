import { chromium, Page } from "playwright";
import { format, addDays, parse, isValid as isValidDate } from "date-fns";
import { log, loadBookings, saveBookings, BookingStatus, getFormattedDate, parseDate } from "./util";

const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;
const WAYLEADR_URL = "https://app.wayleadr.com/users/sign_in";

const SELECTORS = {
  loginPage: {
    emailInput: "#user_email",
    passwordInput: "#user_password",
    signInButton: 'input[type="submit"][value="Sign In"], button:has-text("Sign In")',
    postLoginBookingPageIndicator: 'label:has-text("Dates"), label:has-text("Preferred Zone")',
  },
  dashboard: {
    bookSpaceButton: 'a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)',
  },
  bookingForm: {
    preBookTab: 'a[role="tab"]:has-text("Pre-Book Space"), button[role="tab"]:has-text("Pre-Book Space")',
    dateRangeInputActivator: "input#booking_request_date_range.hasDatepicker",
    calendarContainer: "div#ui-datepicker-div",
    calendarTable: "table.ui-datepicker-calendar",
    dayCellLink: (dayToSelect: string) =>
      `td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default[data-date="${dayToSelect}"]`,
    noSpacesMessage: 'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")',
    requestSpaceButton: 'input#form-submit-button[value="Request Space"]',
    successAlert: 'div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")',
    errorAlert: 'div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")',
  },
};

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

    await page.waitForSelector(SELECTORS.loginPage.emailInput, { timeout: 30000 });
    await page.fill(SELECTORS.loginPage.emailInput, USERNAME!);
    await page.fill(SELECTORS.loginPage.passwordInput, PASSWORD!);

    const loginButtonLocator = page.locator(SELECTORS.loginPage.signInButton);
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
        const bookSpaceButtonLocator = page.locator(SELECTORS.dashboard.bookSpaceButton);
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

    await page.waitForSelector(SELECTORS.loginPage.postLoginBookingPageIndicator, { timeout: 30000 });
    log("INFO", "Successfully navigated to the booking page or a page with booking elements.");
    return true;
  } catch (error: any) {
    log("ERROR", `Login or navigation to booking page failed: ${error.message}`);
    return false;
  }
}

async function bookParkingSpace(page: Page, parkingDateForForm: Date): Promise<BookingStatus> {
  const fullDateForLog = getFormattedDate(parkingDateForForm);
  log("INFO", `Attempting to book parking for date: ${fullDateForLog}`);

  try {
    const preBookTab = page.locator(SELECTORS.bookingForm.preBookTab);
    if (await preBookTab.count() > 0 && await preBookTab.first().isVisible({ timeout: 7000 })) {
      const preBookTabElement = preBookTab.first();
      const isActive = await preBookTabElement.evaluate(
        (node) => node.classList.contains("active") || node.getAttribute("aria-selected") === "true"
      );
      if (!isActive) {
        log("INFO", "Pre-Book Space tab found and is not active. Clicking it.");
        await preBookTabElement.click();
        await page.waitForTimeout(1500);
      } else {
        log("INFO", "Pre-Book Space tab is already active or not found, proceeding.");
      }
    }

    const dateInputActivator = page.locator(SELECTORS.bookingForm.dateRangeInputActivator);
    await dateInputActivator.waitFor({ state: "visible", timeout: 10000 });
    await dateInputActivator.scrollIntoViewIfNeeded();
    await dateInputActivator.click({ force: true, timeout: 7000 });

    const calendarContainerLocator = page.locator(SELECTORS.bookingForm.calendarContainer);
    await calendarContainerLocator.waitFor({ state: "visible", timeout: 15000 });
    const calendarTableLocator = calendarContainerLocator.locator(SELECTORS.bookingForm.calendarTable);
    await calendarTableLocator.waitFor({ state: "visible", timeout: 5000 });

    const dayToSelect = format(parkingDateForForm, "d"); // jel moze
    const dayCellSelector = SELECTORS.bookingForm.dayCellLink(dayToSelect);
    const dayCellLinkLocator = calendarTableLocator.locator(dayCellSelector);
    await dayCellLinkLocator.waitFor({ state: "visible", timeout: 10000 });
    await dayCellLinkLocator.click();
    log("INFO", `Clicked on day ${dayToSelect} for ${fullDateForLog}.`);
    await page.waitForTimeout(1000);

    const noSpacesMessageLocator = page.locator(SELECTORS.bookingForm.noSpacesMessage);
    if (await noSpacesMessageLocator.count() > 0 && await noSpacesMessageLocator.first().isVisible({ timeout: 3000 })) {
      const messageText = await noSpacesMessageLocator.first().textContent();
      log("WARNING", `No spaces available for ${fullDateForLog} (pre-submit check): ${messageText?.trim()}`);
      return "no_spaces";
    }

    const requestSpaceButton = page.locator(SELECTORS.bookingForm.requestSpaceButton);
    await requestSpaceButton.waitFor({ state: "visible", timeout: 15000 });
    log("INFO", "Submitting booking request...");
    await requestSpaceButton.click({ timeout: 30000 });

    const successAlertLocator = page.locator(SELECTORS.bookingForm.successAlert);
    const errorAlertLocator = page.locator(SELECTORS.bookingForm.errorAlert);
    try {
      await page.waitForFunction(
        (selectors) => selectors.some((selector) => !!document.querySelector(selector)),
        [
          SELECTORS.bookingForm.successAlert, 
          SELECTORS.bookingForm.errorAlert,
          SELECTORS.bookingForm.noSpacesMessage,
        ],
        { timeout: 20000 }
      );

      if (await successAlertLocator.count() > 0 && await successAlertLocator.first().isVisible()) {
        const successMsg = await successAlertLocator.first().textContent();
        log("INFO", `Booking successful for ${fullDateForLog}! Message: ${successMsg?.trim()}`);
        return "booked";
      } else if (await noSpacesMessageLocator.count() > 0 && await noSpacesMessageLocator.first().isVisible()) {
        const messageText = await noSpacesMessageLocator.first().textContent();
        log("WARNING", `No spaces available for ${fullDateForLog} (post-submit check): ${messageText?.trim()}`);
        return "no_spaces";
      } else if (await errorAlertLocator.count() > 0 && await errorAlertLocator.first().isVisible()) {
        const errorMsg = await errorAlertLocator.first().textContent();
        log("ERROR", `Booking failed for ${fullDateForLog}. Message: ${errorMsg?.trim()}`);
        return "failed";
      } else {
        log("WARNING", `Booking for ${fullDateForLog} submitted, but outcome unclear (no known success/error/no-space message found). Assuming failure.`);
        return "failed";
      }
    } catch (e: any) {
      log("ERROR", `Timeout or error waiting for booking confirmation for ${fullDateForLog}: ${e.message}. Assuming failure.`);
      return "failed";
    }
  } catch (error: any) {
    log("ERROR", `General error during booking process for ${fullDateForLog}: ${error.message}`);
    return "failed";
  }
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log("ERROR", "Credentials (WAYLEADR_USERNAME, WAYLEADR_PASSWORD) are not set in environment variables.");
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
