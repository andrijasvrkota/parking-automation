import { format } from "date-fns";

export interface Booking {
  parking_date: string; // DD-MM-YYYY
  status: "pending" | "booked" | "failed" | "no_spaces";
  created_at: string;
  last_attempt?: string;
  attempt_message?: string;
}

export const TARGET_DATE_FORMAT = "dd-MM-yyyy";

export function log(level: "INFO" | "ERROR" | "WARNING", message: string): void {
  const timestamp = format(new Date(), TARGET_DATE_FORMAT);
  console.log(`${timestamp} - ${level}: ${message}`);
}