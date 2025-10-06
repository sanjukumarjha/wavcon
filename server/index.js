const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl'); // kept for Spotify info
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec');
const path = require('path');
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const port = process.env.PORT || 3001;

app.use(cors({ origin: 'https://wavcon.vercel.app' }));

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    (error.response && (error.response.status === 429 || error.response.status >= 500)),
});

const cookiesPath = './cookies/youtube_cookies.txt';
const useCookies = process.env.NODE_ENV === 'development' && fs.existsSync(cookiesPath);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
];
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const tempDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

let spotifyToken = { value: null, expirationTime: 0 };

// === Spotify Authentication ===
const getSpotifyToken = async () => {
  if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) return spotifyToken.value;
  console.log('Authenticating with Spotify...');
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials not configured.');

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  spotifyToken.value = response.data.access_token;
  spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
  console.log('Spotify authenticated.');
  return spotifyToken.value;
};

// === Apple artwork ===
const findAppleMusicArtwork = async (track) => {
  try {
    const upc = track.album?.external_ids?.upc;
    if (upc) {
      const r = await axios.get(`https://itunes.apple.com/lookup?upc=${upc}&entity=album`);
      if (r.data.resultCount > 0)
        return r.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
    }
  } catch {}
  try {
    const searchTerm = `${track.album.name} ${track.artists[0].name}`;
    const r = await axios.get(
      `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`
    );
    if (r.data.results.length > 0)
      return r.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
  } catch {}
  return null;
};

// === Spotify track details ===
const getSpotifyTrackDetails = async (trackId) => {
  const token = await getSpotifyToken();
  const r = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const t = r.data;
  return {
    title: t.name,
    subtitle: t.artists.map((a) => a.name).join(', '),
    thumbnail: t.album.images[0]?.url,
    poster: await findAppleMusicArtwork(t),
    platform: 'spotify',
    duration_ms: t.duration_ms,
  };
};

// === YouTube Data API Integration ===
const YT_API_KEY = process.env.YOUTUBE_API_KEY;
if (!YT_API_KEY) console.warn('⚠️  YOUTUBE_API_KEY not set — YouTube search will fail.');

// Helper to parse ISO8601 duration (PT3M30S)
function parseYouTubeDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// Search YouTube via API
async function youtubeSearchWithDurations(query, maxResults = 5) {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${maxResults}&q=${encodeURIComponent(
    query
  )}&key=${YT_API_KEY}`;
  const searchResp = await axios.get(searchUrl);
  const items = searchResp.data.items || [];
  const videoIds = items.map((i) => i.id.videoId).filter(Boolean);
  if (videoIds.length === 0) return [];

  const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds.join(
    ','
  )}&key=${YT_API_KEY}`;
  const videosResp = await axios.get(videosUrl);
  return (videosResp.data.items || []).map((v) => ({
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet.title,
    channel: { name: v.snippet.channelTitle },
    durationInSec: parseYouTubeDuration(v.contentDetails.duration),
  }));
}

app.use(express.json());

// === /api/get-media-data ===
app.post('/api/get-media-data', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    if (url.includes('spotify.com/track/')) {
      const id = url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
      if (!id) return res.status(400).json({ error: 'Invalid Spotify track URL.' });
      return res.json(await getSpotifyTrackDetails(id));
    }

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      const details = await ytdlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true,
        addHeader: ['User-Agent: ' + getRandomUserAgent()],
      });
      const bestThumb = details.thumbnail;
      return res.json({
        title: details.title,
        subtitle: details.uploader || details.channel,
        thumbnail: bestThumb,
        platform: 'youtube',
      });
    }

    res.status(400).json({ error: 'Invalid or unsupported URL.' });
  } catch (err) {
    console.error('--- ERROR in /api/get-media-data ---', err.stack);
    res.status(500).json({ error: 'Server error.' });
  }
});

// === /api/convert ===
app.post('/api/convert', async (req, res) => {
  let tempFilePath = null;
  try {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    let videoUrl, streamTitle;
    if (url.includes('spotify.com/track/')) {
      const id = url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
      if (!id) throw new Error('Invalid Spotify URL.');
      const track = await getSpotifyTrackDetails(id);
      const spotifyDurationSec = track.duration_ms / 1000;
      const searchQuery = `${track.title} ${track.subtitle}`;
      console.log(`Searching YouTube via API for: "${searchQuery}"`);

      let yt_videos = [];
      try {
        yt_videos = await youtubeSearchWithDurations(searchQuery, 5);
      } catch (apiErr) {
        console.error('YouTube API search failed, fallback to yt-dlp:', apiErr.message);
        const ytRaw = await ytdlp.exec(searchQuery, {
          dumpSingleJson: true,
          defaultSearch: 'ytsearch5:',
          noWarnings: true,
          noCheckCertificates: true,
          addHeader: ['User-Agent: ' + getRandomUserAgent()],
        });
        yt_videos = (ytRaw.entries || []).map((e) => ({
          url: e.webpage_url,
          title: e.title,
          durationInSec: e.duration || 0,
          channel: { name: e.uploader },
        }));
      }

      if (yt_videos.length === 0) throw new Error('No YouTube matches found.');
      const bestMatch = yt_videos.reduce((p, c) =>
        Math.abs(c.durationInSec - spotifyDurationSec) < Math.abs(p.durationInSec - spotifyDurationSec) ? c : p
      );
      videoUrl = bestMatch.url;
      streamTitle = track.title;
    } else {
      streamTitle = title;
      videoUrl = url;
    }

    const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
    tempFilePath = path.join(tempDir, `${Date.now()}_${sanitizedTitle}.webm`);

    console.log(`[CONVERT] Downloading: ${videoUrl}`);
   await ytdlp(videoUrl, {
  format: "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
  output: outputPath,
  noWarnings: true,
  noCheckCertificates: true,
  addHeader: ["User-Agent: Mozilla/5.0"],
  cookies: "./cookies/youtube_cookies.txt" // 👈 ADD THIS LINE
});

    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
    res.setHeader('Content-Type', 'audio/wav');

    ffmpeg(tempFilePath)
      .audioBitrate(128)
      .toFormat('wav')
      .audioFrequency(48000)
      .on('error', (err) => {
        console.error('--- FFMPEG ERROR ---', err.message);
        if (!res.headersSent) res.status(500).send('Conversion failed.');
      })
      .on('end', () => {
        console.log(`[FFMPEG] Conversion finished for ${sanitizedTitle}`);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      })
      .pipe(res, { end: true });
  } catch (err) {
    console.error('--- CONVERSION ERROR ---', err.stack);
    if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    if (!res.headersSent) res.status(500).send('Conversion error.');
  }
});

// === /api/download-image ===
app.get('/api/download-image', async (req, res) => {
  const { url, title, type } = req.query;
  if (!url || !title || !type) return res.status(400).json({ error: 'Missing parameters.' });
  try {
    const safeTitle = title.replace(/[^a-z0-9_-\s]/gi, '_').trim();
    const suffix = type === 'poster' ? '_poster' : '_thumbnail';
    const filename = `${safeTitle}${suffix}.jpg`;
    const r = await axios({ method: 'get', url: decodeURIComponent(url), responseType: 'stream' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'image/jpeg');
    r.data.pipe(res);
  } catch (err) {
    console.error('--- IMAGE DOWNLOAD ERROR ---', err.message);
    res.status(500).send('Image download failed.');
  }
});

// === Start Server ===
app.listen(port, async () => {
  console.log(`Server running on http://localhost:${port}`);
  try {
    await getSpotifyToken();
  } catch {
    console.error('Failed to pre-warm Spotify token.');
  }
  console.log('Server initialized.');
});
