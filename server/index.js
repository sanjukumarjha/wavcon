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

app.use(cors({
  origin: 'https://wavcon.vercel.app'
}));

axiosRetry(axios, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
});

// --- NEW: Function to refresh YouTube credentials on server start ---
const refreshYouTubeTokens = async () => {
    try {
        console.log('Attempting to refresh YouTube client data...');
        // This function forces play-dl to get a fresh set of internal tokens from YouTube.
        // This is the server equivalent of getting "fresh cookies".
        await play.getFreeClientID();
        console.log('Successfully refreshed YouTube client data.');
    } catch (error) {
        console.error('!!! FAILED to refresh YouTube client data on startup !!!');
        console.error('YouTube functionality may be limited or fail. This can be due to YouTube blocking the server IP.');
        console.error(`Error details: ${error.message}`);
    }
};

const setupPlayDlSpotifyToken = async () => {
    try {
        await play.setToken({
            spotify: {
                client_id: process.env.SPOTIFY_CLIENT_ID,
                client_secret: process.env.SPOTIFY_CLIENT_SECRET,
            }
        });
        console.log('play-dl successfully configured with Spotify credentials.');
    } catch (error) {
        console.error("!!! FAILED TO CONFIGURE PLAY-DL SPOTIFY TOKEN !!!");
    }
};

const findAppleMusicArtwork = async (track) => {
    // ... (This function remains the same)
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
    // ... (This function remains the same)
    const fullTrackUrl = `https://open.spotify.com/track/${trackId}`;
    const track = await play.spotify(fullTrackUrl); 
    if (!track) throw new Error(`Could not find Spotify track details for ID: ${trackId}`);
    return {
        title: track.name,
        subtitle: track.artists.map(a => a.name).join(', '),
        thumbnail: track.album?.images[0]?.url,
        poster: await findAppleMusicArtwork(track),
        platform: 'spotify',
        duration_ms: track.durationInMs,
    };
};

app.use(express.json());

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
            const info = await play.video_info(url);
            const details = info.video_details;
            res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: details.thumbnails.pop()?.url, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- FATAL ERROR in /api/get-media-data ---", err.stack); 
        res.status(500).json({ error: 'An internal server error occurred while fetching media data.' });
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

            let bestMatch = null;
            let highestScore = -Infinity;

            for (const video of yt_videos) {
                let score = 0;
                const durationDiff = Math.abs(spotifyDurationSec - video.durationInSec);
                if (durationDiff > 10) continue;

                const videoTitle = video.title.toLowerCase();
                if (video.channel?.name.toLowerCase().includes(artistName.toLowerCase())) score += 20;
                if (videoTitle.includes("official audio")) score += 15;
                score -= durationDiff;
                
                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = video;
                }
            }
            if (!bestMatch) bestMatch = yt_videos[0];
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using play-dl stream.`);
        
        const stream = await play.stream(videoUrl, { discordPlayerCompatibility: true });
        
        ffmpeg(stream.stream)
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('error', (err) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`))
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.message, err.stack);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

app.get('/api/download-image', (req, res) => {
    // This endpoint remains the same
});

// --- UPDATED: Server startup logic ---
app.listen(port, async () => {
    console.log(`Server is running on http://localhost:${port}`);
    // Run both initialization steps
    await setupPlayDlSpotifyToken(); 
    await refreshYouTubeTokens(); // Add the YouTube token refresh
    console.log("Server initialized and listening.");
});