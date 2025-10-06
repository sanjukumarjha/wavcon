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

// Apply a global retry mechanism to all axios requests for stability
axiosRetry(axios, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && (error.response.status === 429 || error.response.status >= 500));
    },
    onRetry: (retryCount, error) => {
        console.log(`Request failed (${error.response?.status || 'network error'}). Retrying attempt #${retryCount}...`);
    }
});

const cookiesPath = "./cookies.txt"; 
const useCookies = fs.existsSync(cookiesPath);

// --- RE-IMPLEMENTED: Robust, self-managed Spotify Token Logic ---
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
        throw new Error('Spotify credentials not configured in environment variables.');
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
        console.error("!!! FAILED TO AUTHENTICATE WITH SPOTIFY AFTER ALL RETRIES !!!");
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

// --- UPDATED: getSpotifyTrackDetails uses our own token logic ---
const getSpotifyTrackDetails = async (trackId) => {
    const token = await getSpotifyToken(); // Use our reliable token function
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
            let bestThumbnailUrl = details.thumbnails.pop()?.url;
            res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: bestThumbnailUrl, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- FATAL ERROR in /api/get-media-data ---");
        console.error(err.stack); 
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

            const DURATION_TOLERANCE_SEC = 7;
            const potentialMatches = yt_videos.filter(video => Math.abs(spotifyDurationSec - video.durationInSec) < DURATION_TOLERANCE_SEC);

            let bestMatch = null;
            if (potentialMatches.length === 0) {
                 let closestVideo = yt_videos[0];
                 let smallestDiff = Math.abs(spotifyDurationSec - yt_videos[0].durationInSec);
                 for(const video of yt_videos.slice(1)) {
                     const diff = Math.abs(spotifyDurationSec - video.durationInSec);
                     if (diff < smallestDiff) {
                         smallestDiff = diff;
                         closestVideo = video;
                     }
                 }
                 bestMatch = closestVideo;
            } else {
                let highestScore = -Infinity;
                for (const video of potentialMatches) {
                    let score = 0;
                    const videoTitle = video.title.toLowerCase();
                    const artistNameLower = artistName.toLowerCase();
                    if (video.channel?.name.toLowerCase().includes(artistNameLower)) score += 20;
                    if (videoTitle.includes("official audio")) score += 15;
                    score -= Math.abs(spotifyDurationSec - video.durationInSec);
                    if (score > highestScore) {
                        highestScore = score;
                        bestMatch = video;
                    }
                }
                if (!bestMatch) bestMatch = potentialMatches[0];
            }
            videoUrl = bestMatch.url;
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
            .on('error', (err) => {
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.message);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

app.get('/api/download-image', async (req, res) => {
    // This endpoint remains the same
});

app.listen(port, async () => {
    console.log(`Server is running on http://localhost:${port}`);
    // Pre-warm the token on startup using our reliable function
    await getSpotifyToken(); 
    console.log("Server initialized and listening.");
});
