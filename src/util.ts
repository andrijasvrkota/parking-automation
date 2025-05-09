import { format, parse } from "date-fns";
import path from "path";
import * as fs from "fs/promises";

const BOOKINGS_FILE = path.join(__dirname, "..", "bookings.json");

export type BookingStatus = "pending" | "booked" | "failed" | "no_spaces";
export interface Booking {
  parking_date: string; // DD-MM-YYYY
  status: BookingStatus;
  created_at: string;
  last_attempt?: string;
  attempt_message?: string;
}

const TARGET_DATE_FORMAT = "dd-MM-yyyy";

export function log(level: "INFO" | "ERROR" | "WARNING", message: string): void {
  const timestamp = format(new Date(), TARGET_DATE_FORMAT);
  console.log(`${timestamp} - ${level}: ${message}`);
}

export async function loadBookings(): Promise<Booking[]> {
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

export async function saveBookings(bookings: Booking[]): Promise<boolean> {
  try {
    await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
    log("INFO", `Bookings saved to ${BOOKINGS_FILE}`);
    return true;
  } catch (error: any) {
    log("ERROR", `Error saving bookings: ${error.message}`);
    return false;
  }
}

export function getFormattedDate(date: Date) : string {
  return format(date, TARGET_DATE_FORMAT);
}

export function parseDate(dateStr: string) : Date {
  return parse(dateStr, TARGET_DATE_FORMAT, new Date());
}

export function getDay(date: Date): string {
  return format(date, "d");
}