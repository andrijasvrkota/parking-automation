import { isValid as isValidDate } from "date-fns";
import { getFormattedDate, loadBookings, log, parseDate, saveBookings } from "./util";

const RESET_STATUSES = ["failed", "no_space"];

async function addBookingEntry(dateStr: string): Promise<boolean> {
  const date = parseDate(dateStr);
  if (!isValidDate(date) || getFormattedDate(date) !== dateStr) {
    log("ERROR", `Invalid date: ${dateStr}. Use DD-MM-YYYY.`);
    process.exit(1);
  }

  const bookings = await loadBookings();
  const existing = bookings.find(b => b.parking_date === dateStr);

  if (existing) {
    if (!RESET_STATUSES.includes(existing.status)) return false;
    Object.assign(existing, { status: "pending", last_attempt: undefined, attempt_message: "Re-added" });
    log("INFO", `Reset ${dateStr} to pending.`);
  } else {
    bookings.push({ parking_date: dateStr, status: "pending", created_at: getFormattedDate(new Date()), last_attempt: undefined });
    log("INFO", `Added booking ${dateStr}.`);
  }

  bookings.sort((a, b) => parseDate(a.parking_date).getTime() - parseDate(b.parking_date).getTime());
  return saveBookings(bookings);
}

function parseCliArgs(): string {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    log("ERROR", "Usage: npm run add-booking <DD-MM-YYYY>");
    process.exit(1);
  }
  return args[0];
}

async function main(): Promise<void> {
  const date = parseCliArgs();
  const success = await addBookingEntry(date);
  process.exit(success ? 0 : 1);
}

main().catch(error => {
  log("ERROR", error.message);
  process.exit(1);
});