import * as fs from "fs/promises";
import * as path from "path";
import { parse, parseISO, isValid as isValidDate, format } from "date-fns";
import { Booking, TARGET_DATE_FORMAT, log } from "./util";

const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json");

async function loadBookings(): Promise<Booking[]> {
  try {
    const data = await fs.readFile(BOOKINGS_FILE, "utf8");
    return JSON.parse(data) as Booking[];
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    log("ERROR", `Error loading bookings: ${error.message}`);
    return [];
  }
}

async function saveBookings(bookings: Booking[]): Promise<boolean> {
  try {
    await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
    log("INFO", `Bookings saved to ${BOOKINGS_FILE}`);
    return true;
  } catch (error: any) {
    log("ERROR", `Error saving bookings: ${error.message}`);
    return false;
  }
}

async function addBookingEntry(dateStr: string): Promise<boolean> {
  try {
    const parkingDate = parse(dateStr, TARGET_DATE_FORMAT, new Date());
    if (!isValidDate(parkingDate) || format(parkingDate, TARGET_DATE_FORMAT) !== dateStr) {
      log("ERROR", `Invalid date format: "${dateStr}". Please use DD-MM-YYYY format (e.g., 31-12-2025).`);
      return false;
    }

    const bookings = await loadBookings();
    const existingBooking = bookings.find((b) => b.parking_date === dateStr);

    if (existingBooking) {
      log("WARNING", `Booking for ${dateStr} already exists with status: ${existingBooking.status}.`);
      if (
        existingBooking.status === "failed" ||
        existingBooking.status === "no_spaces"
      ) {
        existingBooking.status = "pending";
        existingBooking.last_attempt = undefined;
        existingBooking.attempt_message = "Re-added by user";
        log("INFO", `Status for ${dateStr} reset to 'pending'.`);
      } else {
        return false;
      }
    } else {
      const newBooking: Booking = {
        parking_date: dateStr,
        status: "pending",
        created_at: new Date().toISOString(),
        last_attempt: undefined,
      };
      bookings.push(newBooking);
      log("INFO", `Added new booking for ${dateStr}`);
    }

    bookings.sort(
      (a, b) =>
        new Date(a.parking_date).getTime() - new Date(b.parking_date).getTime()
    );

    return await saveBookings(bookings);
  } catch (error: any) {
    log("ERROR", `Error adding booking for ${dateStr}: ${error.message}`);
    return false;
  }
}

async function mainCli(): Promise<void> {
  const args = process.argv.slice(2);

  const addIndex = args.indexOf("--add");
  if (addIndex !== -1 && addIndex + 1 < args.length) {
    const dateStr = args[addIndex + 1];
    await addBookingEntry(dateStr);
    return;
  }

  log("ERROR", "Invalid arguments.");
}

mainCli().catch((error) => {
  log("ERROR", `Unhandled error in add-booking CLI: ${error.message}`);
  process.exit(1);
});
