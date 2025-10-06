import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import ytdl from "ytdl-core";
import fetch from "node-fetch";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ============ SPOTIFY AUTH ============
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;

  try {
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      {
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    spotifyToken = response.data.access_token;
    spotifyTokenExpiry = Date.now() + response.data.expires_in * 1000;
    console.log("✅ Spotify token refreshed");
    return spotifyToken;
  } catch (err) {
    console.error("❌ Error getting Spotify token:", err.message);
    return null;
  }
}

// ============ YOUTUBE TO WAV ============
app.post("/api/youtube-to-wav", async (req, res) => {
  try {
    const { url } = req.body;
    if (!ytdl.validateURL(url))
      return res.status(400).json({ error: "Invalid YouTube URL" });

    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, "_");
    const filePath = path.join("/tmp", `${title}.wav`);

    const audio = ytdl(url, { quality: "highestaudio" });
    const ffmpeg = (await import("fluent-ffmpeg")).default;
    ffmpeg(audio)
      .audioFrequency(48000)
      .audioCodec("pcm_s16le")
      .toFormat("wav")
      .save(filePath)
      .on("end", () => {
        res.download(filePath, `${title}.wav`, (err) => {
          fs.unlink(filePath, () => {});
          if (err) console.error("Download error:", err);
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Conversion failed" });
      });
  } catch (err) {
    console.error("YouTube conversion error:", err);
    if (err.message.includes("429"))
      return res
        .status(429)
        .json({ error: "YouTube rate limit. Try again in 2–5 minutes." });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ============ SPOTIFY SONG DETAILS ============
app.post("/api/spotify-song", async (req, res) => {
  try {
    const { url } = req.body;
    const token = await getSpotifyToken();
    if (!token) return res.status(500).json({ error: "Spotify Auth Failed" });

    const match = url.match(/track\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ error: "Invalid Spotify URL" });

    const trackId = match[1];
    const response = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    res.json({
      name: response.data.name,
      artists: response.data.artists.map((a) => a.name).join(", "),
      album: response.data.album.name,
      image: response.data.album.images[0]?.url,
    });
  } catch (err) {
    console.error("Spotify fetch error:", err.message);
    res.status(500).json({ error: "Spotify request failed" });
  }
});

// ============ ROOT ROUTE ============
app.get("/", (req, res) => {
  res.send("🎵 YouTube & Spotify WAV Converter Backend Running");
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
