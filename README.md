# 🚗 Parking Booking Automation

A GitHub Actions–powered workflow that runs **daily at 04:30 AM** (CET/CEST) to automatically reserve your Wayleadr parking for the next day.

## 📋 Overview

Wayleadr only lets you book one day in advance, so if you want to grab a spot you have to log in pretty early. Instead, this script:

- ⏰ **Runs daily at 04:30 AM CET** (03:30 UTC)  
- 🔍 **Verifies** that you’ve scheduled a slot for tomorrow  
- 🔄 **Attempts “Shared Spaces” first**; if none are available, falls back to **“Paid Parking”**  
- 🎯 **Secures your spot** for the next day
- 📊 **Logs each attempt** to `bookings.json` with a status of `pending`, `booked`, `no_space`, or `failed`  

## ⚙️ Configuration

For this to work you just need to do the following:
1. **Fork** this repo. 
2. In **Settings → Secrets and variables → Actions**, add:

| Secret Name | Description |
|-------------|-------------|
| `WAYLEADR_USERNAME` | Your Wayleadr email address |
| `WAYLEADR_PASSWORD` | Your Wayleadr password |
| `GH_PAT` | GitHub token (for pushing updated JSON & commits) |
| `GIT_COMMIT_USER_NAME` | Name for automated commits |
| `GIT_COMMIT_USER_EMAIL` | Email for automated commits |

## 📅 Usage

### Automatic Daily Booking

The system runs automatically every day at 3:30 UTC (4:30 AM Serbian time).
### Manual Booking

To add a specific date for booking:

1. Go to **Actions → Manual Add Booking**.  
2. Click **Run workflow**.  
3. Enter a date in DD-MM-YYYY format.  

### Local Development


#### Add a booking locally
npm run add-booking 15-01-2025

#### Run the booking script locally (requires environment variables)
npm run book

## 📁 Project Structure

```
├── src/
│   ├── wayleadr-page.ts      # Playwright page object
│   ├── parking-booking.ts    # Main booking automation logic
│   ├── add-booking.ts        # CLI script to add new booking entries
│   └── util.ts               # Utility functions and types
├── .github/workflows/
│   ├── daily-parking-booking.yml    # Daily automation workflow
│   └── manual-add-booking.yml       # Manual booking workflow
├── bookings.json             # Auto-generated booking history
└── package.json
```


## 📊 Booking Status Types

- **pending** - Waiting to be processed
- **booked** - Successfully booked
- **failed** - Booking attempt failed
- **no_space** - No parking spaces available