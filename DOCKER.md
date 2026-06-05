# 🐳 Running in Docker & Raspberry Pi

This project is fully containerized. You can build and run it on your laptop inside Docker, or deploy it to a private home server (like a Raspberry Pi) to get a true, production-parity browser automation system for free without using Browserless.io.

---

## 🏗️ 1. How it Works (Production Parity)
1. **Local Chrome Instance**: The container installs a native, headless copy of `chromium` directly inside the Linux environment.
2. **No Timeout Limits**: Because this is a persistent Docker container (not an ephemeral serverless function), there are no 60-second timeouts.
3. **MFA Flow**: 
   * When you submit credentials from your laptop browser, the Docker container on the Raspberry Pi spins up a headless Chromium instance.
   * When it hits the MFA gate, the browser pauses.
   * You type the code in your laptop browser. The code is sent to Upstash Redis.
   * The container reads the code, enters it into the headless browser, completes the download, and serves the PDF back to you.

---

## 📦 2. How to Run Locally in Docker

### Prerequisites
* [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed on your machine.
* A valid `.env` file containing your Upstash credentials in the root directory.

### Commands
1. Build the container:
   ```bash
   docker compose build
   ```
2. Start the application:
   ```bash
   docker compose up
   ```
3. Open your browser to `http://localhost:3000` to run the extraction.

---

## 🍓 3. How to Deploy to a Raspberry Pi

Raspberry Pi models (Raspberry Pi 3, 4, 5) run on **ARM64** processors. Our Dockerfile is designed to be cross-platform: it installs the official Debian `chromium` package, which automatically resolves to the ARM64 version of Chromium when built on the Pi.

### Steps to Deploy
1. **Install Docker on the Pi**:
   Log in to your Raspberry Pi via SSH and install Docker:
   ```bash
   curl -sSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   # Log out and log back in to apply group changes
   ```

2. **Clone and Setup the Project**:
   Clone your repository onto the Pi and create a `.env` file in the project root:
   ```env
   UPSTASH_REDIS_REST_URL="YOUR_UPSTASH_URL"
   UPSTASH_REDIS_REST_TOKEN="YOUR_UPSTASH_TOKEN"
   ```

3. **Build & Run**:
   Run the following command on the Pi:
   ```bash
   docker compose up --build -d
   ```

4. **Accessing the App**:
   You can now open the app from any device on your local home network (like your laptop) by navigating to the Raspberry Pi's local IP address:
   ```text
   http://<RASPBERRY_PI_IP>:3000
   ```
   *(For example: `http://192.168.1.50:3000`)*
