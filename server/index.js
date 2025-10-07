const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';

// --- CORS CONFIGURATION ---
const allowedOrigins = [
  'https://wavcon.vercel.app',
  'https://wavcon-p7nq9h39w-rjriva00-gmailcoms-projects.vercel.app'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204); // Must include headers above
  }

  next();
});


// --- Axios Retry Configuration ---
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           (error.response && (error.response.status === 429 || error.response.status >= 500));
  },
});

const cookiesPath = "./cookies.txt";
const useCookies = fs.existsSync(cookiesPath);

// --- Refresh YouTube Tokens for play-dl ---
const refreshYouTubeTokens = async () => {
  try {
    console.log('Refreshing YouTube client data...');
    await play.getFreeClientID();
    console.log('YouTube client data refreshed.');
  } catch (error) {
    console.error('Failed to refresh YouTube client data:', error.message);
  }
};

// --- Spotify Token Management ---
let spotifyToken = { value: null, expirationTime: 0 };

const getSpotifyToken = async () => {
  if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) return spotifyToken.value;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials missing.');

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    spotifyToken.value = response.data.access_token;
    spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
    return spotifyToken.value;
  } catch (error) {
    console.error("Spotify auth failed:", error.message);
    throw new Error('Spotify authentication failed.');
  }
};

// --- Apple Music Artwork Helper ---
const findAppleMusicArtwork = async (track) => {
  try {
    const upc = track.album?.external_ids?.upc;
    if (upc) {
      const res = await axios.get(`https://itunes.apple.com/lookup?upc=${upc}&entity=album`);
      if (res.data.resultCount > 0) return res.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
    }
  } catch {}
  try {
    const searchTerm = `${track.album.name} ${track.artists[0].name}`;
    const res = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`);
    if (res.data.results.length > 0) return res.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
  } catch {}
  return null;
};

// --- Spotify Track Details Helper ---
const getSpotifyTrackDetails = async (trackId) => {
  const token = await getSpotifyToken();
  const res = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: `Bearer ${token}` } });
  const track = res.data;
  return {
    title: track.name,
    subtitle: track.artists.map(a => a.name).join(', '),
    thumbnail: track.album.images[0]?.url,
    poster: await findAppleMusicArtwork(track),
    platform: 'spotify',
    duration_ms: track.duration_ms,
  };
};

// --- Middleware ---
app.use(express.json());

// --- /api/get-media-data ---
app.post('/api/get-media-data', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    if (url.includes('spotify.com/track/')) {
      const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
      if (!trackIdMatch) return res.status(400).json({ error: 'Invalid Spotify URL.' });
      res.json(await getSpotifyTrackDetails(trackIdMatch[1]));
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const info = await play.video_info(url);
      const details = info.video_details;
      res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: details.thumbnails.pop()?.url, platform: 'youtube' });
    } else {
      res.status(400).json({ error: 'Unsupported URL.' });
    }
  } catch (err) {
    console.error("Error in /api/get-media-data:", err.stack);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// --- /api/convert ---
app.post('/api/convert', async (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    let videoUrl, streamTitle;

    if (url.includes('spotify.com/track/')) {
      const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
      if (!trackIdMatch) throw new Error('Invalid Spotify URL.');
      const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
      streamTitle = trackDetails.title;
      const spotifyDurationSec = trackDetails.duration_ms / 1000;
      const artistName = trackDetails.subtitle;
      const searchQuery = `${trackDetails.title} ${artistName}`;

      const yt_videos = await play.search(searchQuery, { limit: 5 });
      if (!yt_videos.length) throw new Error('No matching YouTube video found.');

      videoUrl = yt_videos.reduce((prev, curr) => Math.abs(curr.durationInSec - spotifyDurationSec) < Math.abs(prev.durationInSec - spotifyDurationSec) ? curr : prev).url;
    } else {
      streamTitle = title;
      videoUrl = url;
    }

    const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
    res.setHeader('Content-Type', 'audio/wav');

    const stream = await play.stream(videoUrl, { discordPlayerCompatibility: true });
    ffmpeg(stream.stream)
      .audioBitrate(128)
      .toFormat('wav')
      .audioFrequency(48000)
      .on('error', (err) => { console.error('FFMPEG ERROR:', err.message); if (!res.headersSent) res.status(500).send('Conversion error'); })
      .on('end', () => console.log(`[FFMPEG] Finished conversion: ${sanitizedTitle}`))
      .pipe(res, { end: true });

  } catch (err) {
    console.error('Conversion endpoint error:', err.stack);
    if (!res.headersSent) res.status(500).send('Error during conversion.');
  }
});

// --- /api/download-image ---
app.get('/api/download-image', async (req, res) => {
  const { url, title, type } = req.query;
  if (!url || !title || !type) return res.status(400).json({ error: 'Missing parameters.' });
  try {
    const sanitizedTitle = title.replace(/[^a-z0-9_-\s]/gi, '_').trim();
    const filename = `${sanitizedTitle}_${type}.jpg`;
    const response = await axios({ method: 'get', url: decodeURIComponent(url), responseType: 'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'image/jpeg');
    response.data.pipe(res);
  } catch (err) {
    console.error('Image download error:', err.message);
    res.status(500).send('Failed to download image.');
  }
});

// --- Server Startup ---
app.listen(port, host, async () => {
  console.log(`Server running on ${host}:${port}`);
  try { await getSpotifyToken(); } catch {}
  await refreshYouTubeTokens();
  console.log('Server initialized.');
});
