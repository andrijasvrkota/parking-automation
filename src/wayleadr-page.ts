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
  private get noSpacesMessage(): Locator { return this.page.locator('div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")'); }
  private get submitButton(): Locator { return this.page.locator('input#form-submit-button[value="Request Space"]'); }
  private get successAlert(): Locator { return this.page.locator('div[class*="alert-success"], div:has-text("Booking successful"), div:has-text("Request submitted")'); }
  private get errorAlert(): Locator { return this.page.locator('div[class*="alert-danger"], div[class*="alert-error"], div:has-text("error")'); }

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
  }

  async submit(): Promise<BookingStatus> {
    if (await this.noSpacesMessage.isVisible({ timeout: 3000 }).catch(() => false)) return "no_space";
    await this.clickWhenReady(this.submitButton, 20000);
    await this.page.waitForFunction(
      (selectors) => selectors.some((s: string) => !!document.querySelector(s)),
      [
        'div[class*="alert-success"]',
        'div:has-text("Booking successful")',
        'div:has-text("Request submitted")',
        'div[class*="alert-danger"]',
        'div[class*="alert-error"]',
        'div:has-text("error")',
        'div:text-matches("There are no available spaces", "i"), p:text-matches("There are no available spaces", "i")'
      ],
      { timeout: 20000 }
    );
    if (await this.successAlert.isVisible().catch(() => false)) return "booked";
    if (await this.noSpacesMessage.isVisible().catch(() => false)) return "no_space";
    if (await this.errorAlert.isVisible().catch(() => false)) return "failed";
    return "failed";
  }
}
