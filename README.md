# 🚗 Parking Booking Automation

An automated parking booking system for Wayleadr that runs daily via GitHub Actions.

## 📋 Overview

This project automates the tedious process of booking parking spaces through the Wayleadr platform. It:

- 🕐 Runs automatically every day at 4:30 AM (Serbian time)
- 🎯 Books parking for the next day when spaces become available
- 🔄 Handles both shared spaces and paid parking options
- 📊 Tracks booking history and status
- 🛡️ Includes retry logic and error handling


## ⚙️ Configuration

### Environment Variables

You'll need to set up the following secrets in your GitHub repository:

| Secret Name | Description |
|-------------|-------------|
| `WAYLEADR_USERNAME` | Your Wayleadr email address |
| `WAYLEADR_PASSWORD` | Your Wayleadr password |
| `GH_PAT` | GitHub Personal Access Token with repo write access |
| `GIT_COMMIT_USER_NAME` | Name for automated commits |
| `GIT_COMMIT_USER_EMAIL` | Email for automated commits |

### Setting up GitHub Secrets

1. Go to your repository → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add each of the required secrets listed above

## 📅 Usage

### Automatic Daily Booking

The system runs automatically every day at 3:30 UTC (4:30 AM Serbian time). No manual intervention required!

### Manual Booking

To add a specific date for booking:

1. Go to Actions tab in your GitHub repository
2. Select "Manual Add Booking" workflow
3. Click "Run workflow"
4. Enter the date in DD-MM-YYYY format
5. Click "Run workflow"

### Local Development

```bash
# Add a booking locally
npm run add-booking -- 15-01-2025

# Run the booking script locally (requires environment variables)
npm run book
```

## 📁 Project Structure

```
├── src/
│   ├── wayleadr-page.ts      # Playwright page object for Wayleadr
│   ├── parking-booking.ts    # Main booking automation logic
│   ├── add-booking.ts        # Script to add new booking entries
│   └── util.ts               # Utility functions and types
├── .github/workflows/
│   ├── daily-parking-booking.yml    # Daily automation workflow
│   └── manual-add-booking.yml       # Manual booking workflow
├── bookings.json             # Booking history and status (auto-generated)
└── package.json
```

## 📊 Booking Status Types

- **`pending`** - Waiting to be processed
- **`booked`** - Successfully booked
- **`failed`** - Booking attempt failed
- **`no_space`** - No parking spaces available

## 🔧 Troubleshooting

### Common Issues

**Booking fails repeatedly**
- Check if your Wayleadr credentials are correct
- Verify the website structure hasn't changed
- Check GitHub Actions logs for detailed error messages

**GitHub Actions workflow not running**
- Ensure repository secrets are properly configured
- Check if the workflow file syntax is correct
- Verify your GitHub PAT has sufficient permissions

**Local development issues**
- Make sure environment variables are set
- Run `npm run build` after making changes
- Check that Playwright browsers are installed

### Debugging

Enable debug mode by running locally:
```bash
NODE_ENV=development npm run book
```

This will run the browser in non-headless mode so you can see what's happening.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is for personal use. Please respect Wayleadr's terms of service and use responsibly.

## ⚠️ Disclaimer

This automation tool is created for personal convenience. Please ensure you comply with Wayleadr's terms of service and use this tool responsibly. The authors are not responsible for any issues arising from the use of this automation.

## 📞 Support

If you encounter issues or have questions:

1. Check the [Issues](../../issues) page for existing solutions
2. Review the GitHub Actions logs for error details
3. Create a new issue with detailed information about the problem

---

**Happy parking!** 🎉