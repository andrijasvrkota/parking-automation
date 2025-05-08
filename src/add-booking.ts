import * as fs from "fs/promises";
import * as path from "path";
import { parseISO, isValid as isValidDate, format } from "date-fns";

// --- Configuration ---
const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json"); // Adjusted path

// --- Interface (duplicate from parking-booking.ts for standalone use, or share via a types file) ---
interface Booking {
  parking_date: string; // YYYY-MM-DD
  status: "pending" | "booked" | "failed" | "no_spaces";
  created_at: string; // ISO Date string
  last_attempt: string | null; // ISO Date string
  attempt_message?: string;
}

// --- File Operations ---
async function loadBookings(): Promise<Booking[]> {
  try {
    const data = await fs.readFile(BOOKINGS_FILE, "utf8");
    return JSON.parse(data) as Booking[];
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return []; // File doesn't exist, start with an empty array
    }
    console.error(`Error loading bookings: ${error.message}`);
    return []; // Return empty on other errors to prevent crash
  }
}

async function saveBookings(bookings: Booking[]): Promise<boolean> {
  try {
    await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
    console.log(`Bookings saved to ${BOOKINGS_FILE}`);
    return true;
  } catch (error: any) {
    console.error(`Error saving bookings: ${error.message}`);
    return false;
  }
}

// --- Booking Management ---
async function addBookingEntry(dateStr: string): Promise<boolean> {
  try {
    const parkingDate = parseISO(dateStr); // Expects YYYY-MM-DD
    if (
      !isValidDate(parkingDate) ||
      format(parkingDate, "yyyy-MM-dd") !== dateStr
    ) {
      console.error(
        `Invalid date format: "${dateStr}". Please use YYYY-MM-DD format (e.g., 2024-12-31).`
      );
      return false;
    }

    const bookings = await loadBookings();
    const existingBooking = bookings.find((b) => b.parking_date === dateStr);

    if (existingBooking) {
      console.warn(
        `Booking for ${dateStr} already exists with status: ${existingBooking.status}.`
      );
      if (
        existingBooking.status === "failed" ||
        existingBooking.status === "no_spaces"
      ) {
        existingBooking.status = "pending"; // Reset to pending if user re-adds a failed one
        existingBooking.last_attempt = null;
        existingBooking.attempt_message = "Re-added by user";
        console.log(`Status for ${dateStr} reset to 'pending'.`);
      } else {
        return false; // Don't modify if 'booked' or already 'pending'
      }
    } else {
      const newBooking: Booking = {
        parking_date: dateStr,
        status: "pending",
        created_at: new Date().toISOString(),
        last_attempt: null,
      };
      bookings.push(newBooking);
      console.log(`Added new booking for ${dateStr}`);
    }

    bookings.sort(
      (a, b) =>
        new Date(a.parking_date).getTime() - new Date(b.parking_date).getTime()
    );

    return await saveBookings(bookings);
  } catch (error: any) {
    console.error(`Error adding booking for ${dateStr}: ${error.message}`);
    return false;
  }
}

async function listBookings(): Promise<void> {
  const bookings = await loadBookings();
  if (bookings.length === 0) {
    console.log("No bookings scheduled.");
    return;
  }

  console.log("\nScheduled bookings:");
  console.log(
    "---------------------------------------------------------------------------"
  );
  console.log(
    "Date        | Status    | Created At           | Last Attempt         | Message"
  );
  console.log(
    "---------------------------------------------------------------------------"
  );
  bookings.forEach((booking) => {
    const created = format(parseISO(booking.created_at), "yyyy-MM-dd HH:mm");
    const attempt = booking.last_attempt
      ? format(parseISO(booking.last_attempt), "yyyy-MM-dd HH:mm")
      : "N/A";
    const message = booking.attempt_message
      ? booking.attempt_message.substring(0, 20) +
        (booking.attempt_message.length > 20 ? "..." : "")
      : "N/A";
    console.log(
      `${booking.parking_date} | ${booking.status.padEnd(
        9
      )} | ${created} | ${attempt.padEnd(20)} | ${message}`
    );
  });
  console.log(
    "---------------------------------------------------------------------------\n"
  );
}

function printHelp(): void {
  console.log(`
Usage:
  node dist/add-booking.js --add YYYY-MM-DD    Add a new booking for the specified date.
                                            (e.g., node dist/add-booking.js --add 2024-05-10)
  node dist/add-booking.js --list              List all scheduled bookings.
  node dist/add-booking.js --help              Show this help message.
  `);
}

// --- Main Execution ---
async function mainCli(): Promise<void> {
  const args = process.argv.slice(2); // Skip 'node' and script path

  if (args.length === 0 || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.includes("--list")) {
    await listBookings();
    return;
  }

  const addIndex = args.indexOf("--add");
  if (addIndex !== -1 && addIndex + 1 < args.length) {
    const dateStr = args[addIndex + 1];
    await addBookingEntry(dateStr);
    return;
  }

  console.error("Invalid arguments.");
  printHelp();
}

mainCli().catch((error) => {
  console.error(`Unhandled error in add-booking CLI: ${error.message}`);
  process.exit(1);
});
