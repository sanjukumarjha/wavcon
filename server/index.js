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

// --- CONSOLIDATED AND CORRECTED CORS CONFIGURATION ---

const allowedOrigins = [
  'https://wavcon.vercel.app',
  'https://wavcon-p7nq9h39w-rjriva00-gmailcoms-projects.vercel.app' // add any preview deploys
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Credentials", "true");
  }
  // Allow preflight requests
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Check if the origin is in our allowed list
    if (allowedOrigins.some(allowedOrigin => 
        typeof allowedOrigin === 'string' ? allowedOrigin === origin : allowedOrigin.test(origin)
    )) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// Use the single, correct CORS configuration for all requests
app.use(cors(corsOptions));

// Explicitly handle preflight requests for all routes
app.options('*', cors(corsOptions));

// --- END OF CORS CONFIGURATION ---

// Apply a global retry mechanism to all axios requests for stability
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && (error.response.status === 429 || error.response.status >= 500));
    },
});

const cookiesPath = "./cookies.txt"; // Relative path for deployment
const useCookies = fs.existsSync(cookiesPath); // Unused for YouTube, but kept for structure

// --- DEFINITIVE FIX: Function to refresh YouTube credentials for play-dl on server start ---
const refreshYouTubeTokens = async () => {
    try {
        console.log('Attempting to refresh YouTube client data for play-dl...');
        // This is the server equivalent of getting "fresh cookies" and is critical for deployment.
        await play.getFreeClientID();
        console.log('Successfully refreshed YouTube client data.');
    } catch (error) {
        console.error('!!! FAILED to refresh YouTube client data on startup !!!');
        console.error('YouTube functionality may be limited. This can be due to YouTube blocking the server IP. Error:', error.message);
    }
};

let spotifyToken = {
    value: null,
    expirationTime: 0,
};

// Uses robust, self-managed token logic
const getSpotifyToken = async () => {
    if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) {
        return spotifyToken.value;
    }
    console.log('Authenticating with Spotify...');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Spotify credentials not configured.');
    
    const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        method: 'post',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: 'grant_type=client_credentials',
    };
    try {
        const response = await axios(authOptions);
        spotifyToken.value = response.data.access_token;
        spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
        console.log('Successfully authenticated with Spotify.');
        return spotifyToken.value;
    } catch (error) {
        console.error("!!! FAILED TO AUTHENTICATE WITH SPOTIFY !!!", error.message);
        throw new Error('Spotify authentication failed.');
    }
};

const findAppleMusicArtwork = async (track) => {
    try {
        const upc = track.album?.external_ids?.upc;
        if (upc) {
            const response = await axios.get(`https://itunes.apple.com/lookup?upc=${upc}&entity=album`);
            if (response.data.resultCount > 0) return response.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
        }
    } catch (e) { /* Fallback */ }
    try {
        const searchTerm = `${track.album.name} ${track.artists[0].name}`;
        const response = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`);
        if (response.data.results.length > 0) {
            return response.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
        }
    } catch (e) { /* No artwork found */ }
    return null;
};

const getSpotifyTrackDetails = async (trackId) => {
    const token = await getSpotifyToken();
    const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
    const response = await axios.get(trackUrl, { headers: { 'Authorization': `Bearer ${token}` } });
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

app.use(express.json());

// --- DEFINITIVE /api/get-media-data ENDPOINT using play-dl ---
app.post('/api/get-media-data', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required.' });

        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) return res.status(400).json({ error: 'Invalid Spotify track URL.' });
            res.json(await getSpotifyTrackDetails(trackIdMatch[1]));
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log(`Fetching YouTube metadata with play-dl for: ${url}`);
            const info = await play.video_info(url);
            const details = info.video_details;
            res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: details.thumbnails.pop()?.url, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- FATAL ERROR in /api/get-media-data ---", err.stack);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- DEFINITIVE /api/convert ENDPOINT using play-dl ---
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
            if (yt_videos.length === 0) throw new Error('Could not find a match on YouTube.');

            let bestMatch = yt_videos.reduce((prev, curr) => 
                (Math.abs(curr.durationInSec - spotifyDurationSec) < Math.abs(prev.durationInSec - spotifyDurationSec) ? curr : prev)
            );
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using stable play-dl stream.`);
        
        const stream = await play.stream(videoUrl, { discordPlayerCompatibility: true });
        
        ffmpeg(stream.stream)
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('error', (err, stdout, stderr) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                console.error("[FFMPEG STDERR]:", stderr);
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`))
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.stack);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

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
        console.error("--- IMAGE DOWNLOAD PROXY ERROR ---", err.message);
        res.status(500).send('Failed to download image.');
    }
});

// --- DEFINITIVE Server startup logic ---
app.listen(port, host, async () => {
    console.log(`Server is running on port ${port}`);
    try {
        await getSpotifyToken();
    } catch (error) {
        console.error("Failed to pre-warm Spotify token, will try again on first request.");
    }
    await refreshYouTubeTokens(); // Critical step for YouTube stability
    console.log("Server initialized and listening.");
});
