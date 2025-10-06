import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import * as play from "play-dl";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ✅ Apply CORS globally before any routes
app.use(
  cors({
    origin: ["https://wavcon.vercel.app", "http://localhost:5173"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ✅ Handle preflight for all routes
app.options("*", cors());

app.use(express.json());

// ✅ Keep-alive test
app.get("/", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send("✅ WavCon backend running fine!");
});

// 🎵 Get media info (metadata only)
app.post("/api/get-media-data", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    let info;
    let platform = "default";

    if (url.includes("youtube.com") || url.includes("youtu.be")) {
      info = await play.video_info(url);
      platform = "youtube";
    } else if (url.includes("spotify.com")) {
      info = await play.spotify(url);
      platform = "spotify";
    } else {
      return res.status(400).json({ error: "Unsupported platform" });
    }

    const title = info.video_details?.title || info.name || "Unknown Title";
    const subtitle =
      info.video_details?.channel?.name ||
      info.artists?.map((a) => a.name).join(", ") ||
      "Unknown Artist";
    const thumbnail =
      info.video_details?.thumbnail?.url ||
      info.thumbnail?.url ||
      "";

    res.json({ title, subtitle, thumbnail, platform });
  } catch (err) {
    console.error("Metadata fetch failed:", err);
    res.status(500).json({
      error: "Failed to fetch media data",
      details: err.message,
    });
  }
});

// 🎧 Convert to WAV and download
app.post("/api/convert", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { url, title } = req.body;
  if (!url || !title) return res.status(400).send("Missing URL or title");

  const safeTitle = title.replace(/[^a-z0-9_\- ]/gi, "_");
  const outputPath = path.join(__dirname, `${safeTitle}.wav`);

  try {
    console.log("Starting yt-dlp conversion:", url);

    const command = `yt-dlp -x --audio-format wav --audio-quality 0 -o "${outputPath}" "${url}"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("yt-dlp error:", stderr || error.message);
        return res.status(500).send("Conversion failed");
      }

      if (!fs.existsSync(outputPath)) {
        console.error("Output file missing:", outputPath);
        return res.status(404).send("File not found after conversion");
      }

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeTitle}.wav"`
      );

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      stream.on("end", () => {
        fs.unlink(outputPath, (err) => {
          if (err) console.error("Cleanup failed:", err);
          else console.log("Deleted temp file:", outputPath);
        });
      });
    });
  } catch (err) {
    console.error("Conversion failed:", err);
    res.status(500).send("Conversion failed: " + err.message);
  }
});

// 🧹 Auto-clean temp .wav files hourly
setInterval(() => {
  fs.readdir(__dirname, (err, files) => {
    if (err) return;
    files
      .filter((f) => f.endsWith(".wav"))
      .forEach((file) => {
        fs.unlink(path.join(__dirname, file), (err) => {
          if (!err) console.log("🧹 Deleted:", file);
        });
      });
  });
}, 60 * 60 * 1000);

// ✅ Start server
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 Server live at port ${port}`);
});
