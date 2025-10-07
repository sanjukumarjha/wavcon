const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl'); // Kept for its excellent Spotify search/matching
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec'); // Used for all robust YouTube interactions
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
// --- RAILWAY SPECIFIC CHANGES ---
const port = process.env.PORT || 3001; // Railway provides the PORT variable
const host = '0.0.0.0';                // Listen on all network interfaces

// --- RAILWAY SPECIFIC CORS CONFIGURATION ---
const allowedOrigins = [
  'https://wavcon.vercel.app',
  // You can add preview deployment URLs here if needed
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

// Apply a global retry mechanism to all axios requests for stability
axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && (error.response.status === 429 || error.response.status >= 500));
    },
});

const cookiesPath = "./cookies.txt";
const useCookies = fs.existsSync(cookiesPath);

// Self-managed Spotify Token with retries
let spotifyToken = {
    value: null,
    expirationTime: 0,
};

const getSpotifyToken = async () => {
    if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) {
        return spotifyToken.value;
    }
    console.log('Authenticating with Spotify...');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Spotify credentials are not configured in environment variables.');
    }
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
        const token = response.data.access_token;
        spotifyToken.value = token;
        spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
        console.log('Successfully authenticated with Spotify.');
        return token;
    } catch (error) {
        console.error("!!! FAILED TO AUTHENTICATE WITH SPOTIFY !!!");
        if (error.response) console.error('Spotify Error Response:', error.response.data);
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

// --- RAILWAY SPECIFIC: Health Check Route ---
// This prevents the 502 errors by giving Railway a URL to check.
app.get('/', (req, res) => {
    res.status(200).send('Server is healthy and running!');
});


// --- API ROUTES ---

app.post('/api/get-media-data', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required.' });

        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) return res.status(400).json({ error: 'Invalid Spotify track URL.' });
            const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
            res.json(trackDetails);
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log(`Fetching YouTube metadata with ytdlp for: ${url}`);
            const details = await ytdlp(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                cookies: useCookies ? cookiesPath : undefined,
            });

            let bestThumbnailUrl = details.thumbnail;
            if (details.id) {
                const potentialThumbnails = [`https://i.ytimg.com/vi/${details.id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${details.id}/hq720.jpg`];
                for (const thumbUrl of potentialThumbnails) {
                    try {
                        await axios.head(thumbUrl);
                        bestThumbnailUrl = thumbUrl;
                        break;
                    } catch (e) { /* ignore */ }
                }
            }
            res.json({ title: details.title, subtitle: details.uploader || details.channel, thumbnail: bestThumbnailUrl, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- FATAL ERROR in /api/get-media-data ---", err.stack);
        res.status(500).json({ error: 'An internal server error has occurred.' });
    }
});

app.post('/api/convert', async (req, res) => {
    try {
        const { url, title } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required.' });

        let videoUrl, streamTitle;
        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) throw new Error('Invalid Spotify URL for conversion.');
            
            const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
            streamTitle = trackDetails.title;
            const spotifyDurationSec = trackDetails.duration_ms / 1000;
            const artistName = trackDetails.subtitle;
            const searchQuery = `${trackDetails.title} ${artistName}`;
            
            const yt_videos = await play.search(searchQuery, { limit: 10 });
            if (yt_videos.length === 0) throw new Error('Could not find any videos on YouTube.');

            let bestMatch = yt_videos[0];
            let highestScore = -Infinity;

            for (const video of yt_videos) {
                let score = 0;
                const durationDiff = Math.abs(spotifyDurationSec - video.durationInSec);
                if (durationDiff > 15) score -= 20;
                else score += (15 - durationDiff);

                const videoTitle = video.title.toLowerCase();
                if (video.channel?.name.toLowerCase().includes(artistName.toLowerCase())) score += 20;
                if (videoTitle.includes("official audio")) score += 15;
                if (videoTitle.includes("lyrics")) score += 5;
                if (videoTitle.includes("live") || videoTitle.includes("cover") || videoTitle.includes("remix")) score -= 30;
                
                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = video;
                }
            }
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using robust yt-dlp pipe.`);

        const ytdlpArgs = [
            videoUrl,
            '-f', 'bestaudio[ext=webm]/bestaudio/best',
            '-o', '-',
            '--no-warnings',
            '--no-playlist',
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        ];
        if (useCookies) {
            ytdlpArgs.push('--cookies', cookiesPath);
        }

        const ytdlpProcess = ytdlp.exec(ytdlpArgs);

        ffmpeg(ytdlpProcess.stdout)
            .inputOptions('-f', 'webm')
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('error', (err, stdout, stderr) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                console.error("[FFMPEG STDERR]:", stderr);
                ytdlpProcess.kill();
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => {
                console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`);
            })
            .pipe(res, { end: true });

        ytdlpProcess.on('error', (err) => {
            console.error("--- YTDLP PROCESS ERROR ---", err.message);
            if (!res.headersSent) res.status(500).send('Error during audio extraction.');
        });
        ytdlpProcess.on('close', (code) => {
            if (code !== 0 && code !== null && !ytdlpProcess.killed) { 
                console.error(`--- YTDLP PROCESS EXITED ABNORMALLY WITH CODE ${code} ---`);
                if (!res.headersSent) res.status(500).send('Error during audio extraction.');
            }
        });

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
        console.error('Image download error:', err.message);
        res.status(500).send('Failed to download image.');
    }
});


// --- RAILWAY SPECIFIC: Server Startup ---
// Listen on the correct host and port for Railway's network.
app.listen(port, host, async () => {
    console.log(`Server is running on ${host}:${port}`);
    try {
        await getSpotifyToken();
    } catch (error) {
        console.error("Failed to pre-warm Spotify token, will try again on first request.");
    }
    console.log("Server initialized and listening.");
});

