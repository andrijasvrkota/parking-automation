import { Page, Locator } from "playwright";
import { BookingStatus } from "./util";
import { getDay } from "./util";

export class WayleadrPage {
  private readonly DATEPICKER_TIMEOUT = 2000;
  private readonly DEFAULT_TIMEOUT = 20_000;

  constructor(private page: Page) {
    this.page.setDefaultTimeout(this.DEFAULT_TIMEOUT);
    this.page.setDefaultNavigationTimeout(this.DEFAULT_TIMEOUT * 1.5);
  }

  private get emailInput(): Locator    { return this.page.getByRole('textbox', { name: /email/i }); }
  private get passwordInput(): Locator { return this.page.getByPlaceholder('Password'); }
  private get signInButton(): Locator  { return this.page.getByRole('button', { name: 'Sign In' }); }

  private get bookSpaceButton(): Locator    { return this.page.getByRole('link', { name: 'Book Space' }); }
  private get postLoginIndicator(): Locator { return this.page.getByText('You may select multiple dates'); }

  private get dateInput(): Locator { return this.page.getByLabel('Dates'); }
  private get calendar(): Locator  { return this.page.locator('#ui-datepicker-div'); }
  private dayCell(day: string): Locator { return this.calendar.locator(`a.ui-state-default:has-text("${day}")`); }

  private get noSpacesMessage(): Locator { return this.page.getByText('There are no available spaces'); }
  private get submitButton(): Locator    { return this.page.getByRole('button', { name: /Request Space|Book Space/i }); }
  private get successAlert(): Locator     { return this.page.locator('.alert-success'); }
  private get errorAlert(): Locator       { return this.page.locator('.alert-danger'); }
  private get zoneDropdown(): Locator     { return this.page.getByRole('combobox', { name: /Preferred Zone/i }); }
  
  private async click(locator: Locator) {
    await locator.waitFor({ state: 'visible' });
    await locator.click();
  }

  async login(email: string, password: string) {
    await this.goToLoginPage();
    await this.authenticate(email, password);
    await this.navigateToBookingPage();
  }

  async goToLoginPage(): Promise<void> {
    await this.page.goto('https://app.wayleadr.com/users/sign_in');
    await this.emailInput.waitFor();
  }

  async authenticate(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);

    await Promise.all([
      this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      this.signInButton.click(),
    ]);
  }

  async navigateToBookingPage(): Promise<void> {
    await this.click(this.bookSpaceButton);
    await this.page.waitForURL(/\/request\/new/);
    await this.postLoginIndicator.waitFor();
  }

  async selectDate(date: Date) {
    // const day = getDay(date);
    const day = getDay(new Date(2025,6,9));
    await this.click(this.dateInput);
    await this.click(this.calendar);
    await this.click(this.dayCell(day));
    await this.page.locator('body').click({ position: { x: 0, y: 0 } });
    await this.page.waitForTimeout(this.DATEPICKER_TIMEOUT);
  }

  async isSharedSpaceUnavailable(): Promise<boolean> {
    return this.noSpacesMessage.isVisible().catch(() => false);
  }

  async switchToPaidParking() {
    await this.zoneDropdown.selectOption({ label: 'Paid Parking' });
    await this.page.click('body');
  }


  async submit(): Promise<BookingStatus> {
    // await this.click(this.submitButton);

    await Promise.race([
      this.successAlert.waitFor(),
      this.errorAlert.waitFor(),
      this.noSpacesMessage.waitFor(),
    ]);

    if (await this.successAlert.isVisible()) return 'booked';
    if (await this.noSpacesMessage.isVisible()) return 'no_space';
    return 'failed';
  }
}