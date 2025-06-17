import { Page, Locator } from "playwright";
import { BookingStatus, getDay } from "./util";

const DEFAULT_TIMEOUT = 20_000;
const PAID_PARKING_OPTION = 'Paid Parking';
const ESCAPE_BUTTON = 'Escape';
const NETWORK_IDLE_STATE = 'networkidle';

export class WayleadrPage {

  constructor(private page: Page) {
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    this.page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT * 1.5);
  }

  private get emailInput(): Locator { return this.page.getByRole('textbox', { name: /email/i }); }
  private get passwordInput(): Locator { return this.page.getByPlaceholder('Password'); }
  private get signInButton(): Locator { return this.page.getByRole('button', { name: 'Sign In' }); }

  private get bookSpaceButton(): Locator { return this.page.getByRole('link', { name: 'Book Space' }); }
  private get postLoginIndicator(): Locator { return this.page.getByText('You may select multiple dates'); }

  private get dateInput(): Locator { return this.page.getByLabel('Dates'); }
  private get calendar(): Locator { return this.page.locator('#ui-datepicker-div'); }
  private dayCell(day: string): Locator { return this.calendar.locator(`a.ui-state-default:has-text("${day}")`); }

  private get noSpacesMessage(): Locator { return this.page.getByText('There are no available spaces.'); }
  private get submitButton(): Locator { return this.page.getByRole('button', { name: 'Request Space' }); }
  private get successAlert(): Locator { return this.page.locator('.alert-success'); }
  private get errorAlert(): Locator { return this.page.locator('.alert-danger'); }
  private get zoneDropdown(): Locator { return this.page.getByRole('combobox', { name: 'Preferred Zone' }); }
  
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
    this.bookSpaceButton.click();
    await this.page.waitForURL(/\/request\/new/);
    await this.postLoginIndicator.waitFor();
  }

  async selectDate(date: Date) {
    const day = getDay(date);
    await this.dateInput.click();
    await this.calendar.click();
    await this.dayCell(day).click();
    await this.page.keyboard.press(ESCAPE_BUTTON); //dismiss calendar popup
    await this.page.waitForLoadState(NETWORK_IDLE_STATE);
  }

  async isSharedSpaceUnavailable(): Promise<boolean> {
    try {
      await this.noSpacesMessage.waitFor({ timeout: DEFAULT_TIMEOUT });
      return true;
    } catch (_) {
      return false;
    }
  }

  async switchToPaidParking() {
    await this.zoneDropdown.selectOption({ label: PAID_PARKING_OPTION });
    await this.page.click('body');
  }


  async submit(): Promise<BookingStatus> {
    await this.submitButton.click();

    await Promise.any([
      this.successAlert.waitFor(),
      this.errorAlert.waitFor(),
      this.noSpacesMessage.waitFor(),
    ]);

    if (await this.successAlert.isVisible()) return 'booked';
    if (await this.noSpacesMessage.isVisible()) return 'no_space';
    return 'failed';
  }
}