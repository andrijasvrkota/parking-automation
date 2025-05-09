export interface Booking {
  parking_date: string; // DD-MM-YYYY
  status: "pending" | "booked" | "failed" | "no_spaces";
  created_at: string;
  last_attempt?: string;
  attempt_message?: string;
}

export const TARGET_DATE_FORMAT = "dd-MM-yyyy";
