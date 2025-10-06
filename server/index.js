// index.js - Complete YouTube to WAV converter backend
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import ytdlp from "yt-dlp-exec";
import { fileURLToPath } from "url";

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// File path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Folder to store temporary downloads
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Utility function to wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Convert a YouTube video to WAV format using yt-dlp
 * Automatically retries on HTTP 429 (rate-limited)
 * @param {string} videoUrl - YouTube video URL
 * @param {number} retries - number of retry attempts
 * @returns {Promise<string>} - output file path
 */
async function convertYouTubeToWav(videoUrl, retries = 3) {
  try {
    const outputTemplate = path.join(DOWNLOAD_DIR, "%(title)s.%(ext)s");

    console.log(`🎵 Starting conversion: ${videoUrl}`);

    const result = await ytdlp(videoUrl, {
      extractAudio: true,
      audioFormat: "wav",
      audioQuality: "0",
      postprocessorArgs: ["-ar", "48000"], // 48kHz sample rate
      output: outputTemplate,
      restrictFilenames: true,
      // Uncomment and provide cookies if YouTube rate-limits persist
      cookies: "./cookies.txt",
    });

    console.log("✅ Conversion complete:", result);
    return result;
  } catch (err) {
    if (retries > 0 && err.message.includes("429")) {
      console.warn(`⚠️ Rate limited. Retrying in 10s... (${retries} left)`);
      await wait(10000);
      return convertYouTubeToWav(videoUrl, retries - 1);
    }
    console.error("❌ Conversion failed:", err);
    throw err;
  }
}

// API route to convert YouTube video to WAV
app.post("/convert", async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: "Missing YouTube video URL" });
  }

  try {
    await convertYouTubeToWav(videoUrl);

    // Find the latest file in downloads
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const latestFile = files
      .map((f) => ({
        name: f,
        time: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time)[0];

    if (!latestFile) throw new Error("File not found after conversion");

    const filePath = path.join(DOWNLOAD_DIR, latestFile.name);

    // Send file to client
    res.download(filePath, (err) => {
      if (err) console.error("❌ File download error:", err);
      // Optional: delete file after sending
      // fs.unlinkSync(filePath);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test route
app.get("/", (req, res) => {
  res.send("✅ YouTube → WAV Converter API is running!");
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
