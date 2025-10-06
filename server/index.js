// server.js
const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3001;

// CORS
app.use(cors({
  origin: 'https://wavcon.vercel.app'
}));
app.use(express.json());

// Axios retry
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

// Temporary directory
const tempDir = path.join(__dirname, '.data');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// YouTube helper to refresh client data
const refreshYouTubeTokens = async () => {
    try {
        console.log('Refreshing YouTube client data...');
        await play.getFreeClientID();
        console.log('YouTube client refreshed.');
    } catch (err) {
        console.error('Failed to refresh YouTube client:', err.message);
    }
};

// Spotify token handling
let spotifyToken = { value: null, expirationTime: 0 };
const getSpotifyToken = async () => {
    if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) return spotifyToken.value;

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Spotify credentials missing');

    const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        method: 'post',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: 'grant_type=client_credentials',
    };

    const response = await axios(authOptions);
    spotifyToken.value = response.data.access_token;
    spotifyToken.expirationTime = Date.now() + (response.data.expires_in - 60) * 1000;
    console.log('Spotify token acquired.');
    return spotifyToken.value;
};

// Fetch Spotify track details
const getSpotifyTrackDetails = async (trackId) => {
    const token = await getSpotifyToken();
    const response = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const track = response.data;
    return {
        title: track.name,
        subtitle: track.artists.map(a => a.name).join(', '),
        duration_ms: track.duration_ms,
    };
};

// --- GET MEDIA DATA ---
app.post('/api/get-media-data', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        if (url.includes('spotify.com/track/')) {
            const trackId = url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
            if (!trackId) return res.status(400).json({ error: 'Invalid Spotify track URL' });
            res.json(await getSpotifyTrackDetails(trackId));
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const info = await play.video_info(url);
            const details = info.video_details;
            res.json({
                title: details.title,
                subtitle: details.channel?.name,
                thumbnail: details.thumbnails.pop()?.url,
                platform: 'youtube'
            });
        } else {
            res.status(400).json({ error: 'Unsupported URL' });
        }
    } catch (err) {
        console.error(err.stack);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- CONVERT ENDPOINT ---
app.post('/api/convert', async (req, res) => {
    try {
        const { url, title } = req.body;
        if (!url) return res.status(400).json({ error: 'URL is required' });

        let videoUrl = url;
        let streamTitle = title || 'audio';

        // Spotify -> search YouTube for matching video
        if (url.includes('spotify.com/track/')) {
            const trackId = url.match(/track\/([a-zA-Z0-9]+)/)?.[1];
            if (!trackId) throw new Error('Invalid Spotify URL');

            const track = await getSpotifyTrackDetails(trackId);
            streamTitle = track.title;
            const searchQuery = `${track.title} ${track.subtitle}`;
            const ytVideos = await play.search(searchQuery, { limit: 5 });
            if (!ytVideos.length) throw new Error('No matching YouTube video found');
            videoUrl = ytVideos[0].url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        const tempMp3 = path.join(tempDir, `${sanitizedTitle}.mp3`);
        const tempWav = path.join(tempDir, `${sanitizedTitle}.wav`);

        console.log(`[CONVERT] Downloading audio: ${sanitizedTitle}`);
        const stream = await play.stream(videoUrl);
        const fileStream = fs.createWriteStream(tempMp3);

        await new Promise((resolve, reject) => {
            stream.stream.pipe(fileStream);
            stream.stream.on('end', resolve);
            stream.stream.on('error', reject);
        });

        console.log(`[FFMPEG] Converting to WAV: ${sanitizedTitle}`);
        await new Promise((resolve, reject) => {
            ffmpeg(tempMp3)
                .toFormat('wav')
                .audioFrequency(48000)
                .on('error', reject)
                .on('end', resolve)
                .save(tempWav);
        });

        res.download(tempWav, `${sanitizedTitle}.wav`, () => {
            fs.unlinkSync(tempMp3);
            fs.unlinkSync(tempWav);
        });

    } catch (err) {
        console.error("Conversion error:", err.stack);
        res.status(500).send('Conversion failed');
    }
});

// --- START SERVER ---
app.listen(port, async () => {
    console.log(`Server running on port ${port}`);
    await refreshYouTubeTokens();
});
