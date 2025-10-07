const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec');
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();

const port = process.env.PORT || 3001;
const host = '0.0.0.0';

const allowedOrigins = [
  'https://wavcon.vercel.app',
  'https://wavcon-p7nq9h39w-rjriva00-gmailcoms-projects.vercel.app'
];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Origin not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && (error.response.status === 429 || error.response.status >= 500)),
});

const cookiesPath = "./cookies.txt";
const useCookies = fs.existsSync(cookiesPath);

let spotifyToken = { value: null, expirationTime: 0 };
const getSpotifyToken = async () => {
    if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) return spotifyToken.value;
    console.log('Authenticating with Spotify...');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Spotify credentials are not configured.');
    try {
        const response = await axios({
            url: 'https://accounts.spotify.com/api/token',
            method: 'post',
            headers: {
                'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: 'grant_type=client_credentials',
        });
        spotifyToken.value = response.data.access_token;
        spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
        console.log('Successfully authenticated with Spotify.');
        return spotifyToken.value;
    } catch (error) {
        console.error("!!! FAILED TO AUTHENTICATE WITH SPOTIFY !!!", error.response ? error.response.data : error.message);
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
        if (response.data.results.length > 0) return response.data.results[0].artworkUrl100.replace('100x100bb.jpg', '3000x3000.jpg');
    } catch (e) { /* No artwork found */ }
    return null;
};

const getSpotifyTrackDetails = async (trackId) => {
    const token = await getSpotifyToken();
    const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
    const response = await axios.get(trackUrl, { headers: { 'Authorization': 'Bearer ' + token } });
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

app.get('/', (req, res) => {
    console.log('Health check endpoint hit successfully.'); 
    res.status(200).send('Server is healthy and running!');
});

app.post('/api/get-media-data', async (req, res) => {
    // ... (rest of the route is unchanged)
});

app.post('/api/convert', async (req, res) => {
    // ... (rest of the route is unchanged)
});

app.get('/api/download-image', async (req, res) => {
    // ... (rest of the route is unchanged)
});

// --- SERVER STARTUP ---
const server = app.listen(port, host, async () => {
    console.log(`Server listening on port ${port}`);
    try {
        await getSpotifyToken();
    } catch (error) {
        console.error("Failed to pre-warm Spotify token.");
    }
    console.log("Server initialized and ready.");
});

// --- GRACEFUL SHUTDOWN HANDLER ---
const gracefulShutdown = (signal) => {
    console.log(`[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    console.log('[SHUTDOWN] This is likely due to the container hitting a memory limit.');
    server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed.');
        process.exit(0);
    });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

