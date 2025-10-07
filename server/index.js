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
const host = process.env.HOST || '0.0.0.0'; // Railway requirement

// --- CORS SETUP ---
// Allow only your Vercel frontend to access the API
app.use(cors({
  origin: 'https://wavcon.vercel.app', 
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// --- Axios retry for robustness ---
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    (error.response && (error.response.status === 429 || error.response.status >= 500)),
});

// --- YouTube client refresh ---
const refreshYouTubeTokens = async () => {
  try {
    console.log('Refreshing YouTube client data...');
    await play.getFreeClientID();
    console.log('YouTube client data refreshed successfully.');
  } catch (error) {
    console.error('Failed to refresh YouTube client data:', error.message);
  }
};

// --- Spotify token management ---
let spotifyToken = { value: null, expirationTime: 0 };

const getSpotifyToken = async () => {
  if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) {
    return spotifyToken.value;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials missing.');

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    method: 'post',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: 'grant_type=client_credentials',
  };

  const response = await axios(authOptions);
  spotifyToken.value = response.data.access_token;
  spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
  return spotifyToken.value;
};

// --- Helper: Apple Music Artwork ---
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

// --- Get Spotify Track Details ---
const getSpotifyTrackDetails = async (trackId) => {
  const token = await getSpotifyToken();
  const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
  const response = await axios.get(trackUrl, { headers: { Authorization: `Bearer ${token}` } });
  const track = response.data;

  return {
    title: track.name,
    subtitle: track.artists.map(a => a.name).join(', '),
    thumbnail: track.album.images[0]?.url,
    poster: await findAppleMusicArtwork(track),
    platform: 'spotify',
    duration_ms: track.duration_ms,
  };
};

// --- /api/get-media-data ---
app.post('/api/get-media-data', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    if (url.includes('spotify.com/track/')) {
      const match = url.match(/track\/([a-zA-Z0-9]+)/);
      if (!match) return res.status(400).json({ error: 'Invalid Spotify URL.' });
      res.json(await getSpotifyTrackDetails(match[1]));
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const info = await play.video_info(url);
      const details = info.video_details;
      res.json({
        title: details.title,
        subtitle: details.channel?.name,
        thumbnail: details.thumbnails.pop()?.url,
        platform: 'youtube',
      });
    } else {
      res.status(400).json({ error: 'Unsupported URL.' });
    }
  } catch (err) {
    console.error(err.stack);
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
      const match = url.match(/track\/([a-zA-Z0-9]+)/);
      if (!match) throw new Error('Invalid Spotify URL.');

      const trackDetails = await getSpotifyTrackDetails(match[1]);
      streamTitle = trackDetails.title;

      // Find best match on YouTube
      const ytResults = await play.search(`${trackDetails.title} ${trackDetails.subtitle}`, { limit: 5 });
      if (!ytResults.length) throw new Error('No matching YouTube video found.');
      videoUrl = ytResults.reduce((prev, curr) =>
        Math.abs(curr.durationInSec - trackDetails.duration_ms / 1000) < Math.abs(prev.durationInSec - trackDetails.duration_ms / 1000) ? curr : prev
      ).url;
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
      .on('error', (err, stdout, stderr) => {
        console.error('[FFMPEG ERROR]', err.message, stderr);
        if (!res.headersSent) res.status(500).send('Error during conversion');
      })
      .on('end', () => console.log(`[FFMPEG] Finished conversion: ${sanitizedTitle}`))
      .pipe(res, { end: true });
  } catch (err) {
    console.error('[CONVERSION ERROR]', err.stack);
    if (!res.headersSent) res.status(500).send('Conversion failed.');
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
    console.error('[IMAGE DOWNLOAD ERROR]', err.message);
    res.status(500).send('Failed to download image.');
  }
});

// --- Server startup ---
app.listen(port, host, async () => {
  console.log(`Server running on http://${host}:${port}`);
  await refreshYouTubeTokens();
  try { await getSpotifyToken(); } catch { console.warn('Spotify token not preloaded. Will fetch on first request.'); }
});
