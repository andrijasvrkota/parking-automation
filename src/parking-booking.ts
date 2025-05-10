import { chromium, Page } from "playwright";
import { addDays, isValid as isValidDate } from "date-fns";
import {
  log,
  loadBookings,
  saveBookings,
  BookingStatus,
  getFormattedDate,
  parseDate,
  Booking,
} from "./util";
import { WayleadrPage } from "./wayleadr-page";

const USERNAME = process.env.WAYLEADR_USERNAME;
const PASSWORD = process.env.WAYLEADR_PASSWORD;

async function updateBookingStatus(date: Date, outcome: BookingStatus, message?: string): Promise<void> {
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
  const filtered = bookings.filter((booking: Booking) => {
    const date = parseDate(booking.parking_date);
    if (!isValidDate(date))  {
      return false;
    }
    date.setHours(0, 0, 0, 0);
    return date >= sevenDaysAgo;
  });
  await saveBookings(filtered);
}

async function main(): Promise<void> {
  if (!USERNAME || !PASSWORD) {
    log("ERROR", "Credentials not set.");
    process.exit(1);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const next = (await loadBookings())
    .filter((b) => b.status === "pending")
    .map((b) => parseDate(b.parking_date))
    .find((d) => addDays(d, -1).setHours(0, 0, 0, 0) === today.getTime());
  if (!next) {
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
    await wp.login(USERNAME!, PASSWORD!);
    await wp.selectDate(next);
    result = await wp.submit();
  } catch (e: any) {
    log("ERROR", `Error: ${e.message}`);
    result = "failed";
  }
  const msg = result === "booked"
      ? `Attempted on ${getFormattedDate(new Date())}. Result: ${result}`
      : `Booking not successful on ${getFormattedDate(new Date())}. Result: ${result}`;
  await updateBookingStatus(next, result, msg);
  await context.close();
  await browser.close();
  if (result !== "booked") {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  log("ERROR", e.message);
  process.exit(1);
});
