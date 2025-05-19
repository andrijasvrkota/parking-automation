import { Page, Locator } from "playwright";
import { BookingStatus } from "./util";
import { getDay } from "./util";

export class WayleadrPage {
  constructor(public page: Page) {}

  private get emailInput(): Locator { return this.page.locator("#user_email"); }
  private get passwordInput(): Locator { return this.page.locator("#user_password"); }
  private get signInButton(): Locator { return this.page.locator('input[type="submit"][value="Sign In"], button:has-text("Sign In")'); }
  private get bookSpaceButton(): Locator { return this.page.locator('a.btn.btn-primary.mr-3:has-text("Book Space"):has(i.fe-plus.mr-2)'); }
  private get postLoginIndicator(): Locator { return this.page.locator('p:has-text("You may select multiple dates")'); }
  private get dateInput(): Locator { return this.page.locator("input#booking_request_date_range.hasDatepicker"); }
  private get calendarContainer(): Locator { return this.page.locator("div#ui-datepicker-div"); }
  private get calendarTable(): Locator { return this.page.locator("table.ui-datepicker-calendar"); }
  private dayCell(day: string): Locator {
    return this.calendarTable.locator(`td:not(.ui-datepicker-unselectable):not(.ui-state-disabled) a.ui-state-default[data-date="${day}"]`);
  }
  private get noSpacesMessage(): Locator { return this.page.locator('#pricing-breakdown li:has-text("There are no available spaces")') }
  private get submitButton(): Locator { return this.page.locator('input#form-submit-button[value="Request Space"]'); }
  private get successAlert(): Locator { return this.page.locator('div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")'); }
  private get errorAlert(): Locator { return this.page.locator('div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")'); }
  private get zoneDropdown(): Locator { return this.page.locator('select#booking_request_preferred_zone_id'); }
  private get paidParkingOption(): Locator { return this.page.locator('option:has-text("Paid Parking")'); }

  private async clickWhenReady(locator: Locator, timeout = 10000) {
    await locator.waitFor({ state: "visible", timeout });
    await locator.click({ timeout });
  }

  async login(username: string, password: string) {
    await this.page.goto("https://app.wayleadr.com/users/sign_in", { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.emailInput.waitFor({ timeout: 30000 });
    await this.emailInput.fill(username);
    await this.passwordInput.fill(password);
    await Promise.all([
      this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 }),
      this.signInButton.click({ timeout: 20000 })
    ]);
    await this.clickWhenReady(this.bookSpaceButton);
    await this.page.waitForURL(/\/request\/new/);
    await this.postLoginIndicator.waitFor({ timeout: 30000 });
  }

  async selectDate(date: Date) {
    await this.clickWhenReady(this.dateInput);
    await this.clickWhenReady(this.calendarContainer);
    await this.clickWhenReady(this.dayCell(getDay(date)));
    await this.page.locator('body').click({ position: { x: 0, y: 0 } }); // click to dismiss calendar popup
    await this.page.waitForTimeout(3000);
    const sharedUnavailable = await this.noSpacesMessage.isVisible({ timeout: 2000 }).catch(() => false);
    if (sharedUnavailable) {
      console.log("Switching to Paid Parking...");
      await this.switchToPaidParking();

      // Wait a bit for UI to update and check again
      await this.page.waitForTimeout(1000);
      await this.page.locator('body').click({ position: { x: 0, y: 0 } }); // maybe help UI update
    }
  }

  async switchToPaidParking() {
    // await this.clickWhenReady(this.zoneDropdown);
    // await this.clickWhenReady(this.paidParkingOption);
    await this.zoneDropdown.waitFor({ state: "visible", timeout: 10000 });
    await this.zoneDropdown.selectOption({ label: "Paid Parking" });
    await this.page.waitForTimeout(1000);
  }

async submit(): Promise<BookingStatus> {
  await this.clickWhenReady(this.submitButton, 20000);

  await Promise.race([
    this.successAlert.waitFor({ timeout: 20000 }).catch(() => {}),
    this.errorAlert.waitFor({ timeout: 20000 }).catch(() => {}),
    this.noSpacesMessage.waitFor({ timeout: 20000 }).catch(() => {}),
  ]);

  if (await this.successAlert.isVisible().catch(() => false)) return "booked";
  if (await this.noSpacesMessage.isVisible().catch(() => false)) return "no_space";
  if (await this.errorAlert.isVisible().catch(() => false)) return "failed";
  return "failed";
}
}