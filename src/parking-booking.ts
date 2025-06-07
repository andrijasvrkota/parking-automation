import { chromium, Page } from "playwright";
import { addDays, isValid as isValidDate } from "date-fns";
import {
  log,
  loadBookings,
  saveBookings,
  BookingStatus,
  getFormattedDate,
  parseDate,
} from "./util";
import { WayleadrPage } from "./wayleadr-page";

const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;
const DAYS_TO_KEEP_BOOKING = 7;

async function updateBookingStatus(date: Date, outcome: BookingStatus, message?: string): Promise<void> {
  const bookings = await loadBookings();
  const booking = bookings.find(b => b.parking_date === getFormattedDate(date));
  
  if (!booking) {
    log("WARNING", `Could not find booking for date ${getFormattedDate(date)}`);
    return;
  }
  
  booking.status = outcome;
  booking.last_attempt = getFormattedDate(new Date());
  if (message) booking.attempt_message = message;
  
  await saveBookings(bookings);
}

async function cleanupOldBookings(): Promise<void> {
  const bookings = await loadBookings();
  const sevenDaysAgo = addDays(new Date(), -DAYS_TO_KEEP_BOOKING);
  
  const filtered = bookings.filter(booking => {
    const date = parseDate(booking.parking_date);
    if (!isValidDate(date)) return false;
    date.setHours(0, 0, 0, 0);
    return date >= sevenDaysAgo;
  });
  
  await saveBookings(filtered);
}
// needed because it's only possible to book 1 day in advance
async function findTomorrowsPendingBooking(): Promise<Date | undefined> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const bookings = await loadBookings();
  return bookings
    .filter(b => b.status === "pending")
    .map(b => parseDate(b.parking_date))
    .find(date => {
      const dayBefore = addDays(date, -1);
      dayBefore.setHours(0, 0, 0, 0);
      return dayBefore.getTime() === today.getTime();
    });
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log("ERROR", "Credentials not set.");
    process.exit(1);
  }
  const targetBookingDate = await findTomorrowsPendingBooking();
  if (!targetBookingDate) {
    log("INFO", "No pending booking for today.");
    return;
  }
  const browser = await chromium.launch({
    headless: process.env.NODE_ENV === "production",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
  });
  const page: Page = await context.newPage();
  const wp = new WayleadrPage(page);
  let result: BookingStatus = "failed";
  try {
    log("INFO", "Logging in to Wayleadr");
    await wp.login(USERNAME!, PASSWORD!);

    log("INFO", "Selecting date");
    await wp.selectDate(targetBookingDate);

    if(await wp.isSharedSpaceUnavailable()) {
      log("INFO", "Shared spaces not available, switching to Paid Parking");
      await wp.switchToPaidParking();
    }

    log("INFO", "Submitting booking request");
    result = await wp.submit();
  } catch (e: any) {
    log("ERROR", `Error: ${e.message}`);
    result = "failed";
  }
  const msg = result === "booked"
      ? `Attempted on ${getFormattedDate(new Date())}. Result: ${result}`
      : `Booking not successful on ${getFormattedDate(new Date())}. Result: ${result}`;
  await updateBookingStatus(targetBookingDate, result, msg);
  await cleanupOldBookings();
  await context.close();
  await browser.close();
  process.exit(result === "booked" ? 0 : 1);
}

main().catch((e) => {
  log("ERROR", e.message);
  process.exit(1);
});
