import { isValid as isValidDate } from "date-fns";
import { getFormattedDate, loadBookings, log, parseDate, saveBookings } from "./util";

const RESET_STATUSES = ["failed", "no_spaces"];

async function addBookingEntry(dateStr: string): Promise<boolean> {
  const date = parseDate(dateStr);
  if (!isValidDate(date) || getFormattedDate(date) !== dateStr) {
    log("ERROR", `Invalid date: ${dateStr}. Use DD-MM-YYYY.`);
    return false;
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

  bookings.sort((a, b) => new Date(a.parking_date).getTime() - new Date(b.parking_date).getTime());
  return saveBookings(bookings);
}

(async () => {
  const [,, flag, date] = process.argv;
  if (flag === "--add" && date) {
    const success = await addBookingEntry(date);
    process.exit(success ? 0 : 1);
  }
  log("ERROR", "Usage: npm run add-booking -- --add <DD-MM-YYYY>");
  process.exit(1);
})();
