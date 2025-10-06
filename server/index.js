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

app.use(cors({
  origin: 'https://wavcon.vercel.app'
}));

axiosRetry(axios, {
    retries: 5,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && (error.response.status === 429 || error.response.status >= 500));
    },
    onRetry: (retryCount, error) => {
        console.log(`Axios request failed (${error.response?.status || 'network error'}). Retrying attempt #${retryCount}...`);
    }
});

const cookiesPath = "./cookies.txt"; 
const useCookies = fs.existsSync(cookiesPath);

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

const getSpotifyTrackDetails = async (trackId) => {
    // This function now relies on the robust getSpotifyToken function we defined
    const token = await getSpotifyToken();
    const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
    const response = await axios.get(trackUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    const track = response.data;

    return {
        title: track.name,
        subtitle: track.artists.map(a => a.name).join(', '),
        thumbnail: track.album?.images[0]?.url,
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
            const details = await ytdlp(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                cookies: useCookies ? cookiesPath : undefined,
            });

            const videoId = details.id;
            let bestThumbnailUrl = details.thumbnail;
            if (videoId) {
                const potentialThumbnails = [`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hq720.jpg`];
                for (const thumbUrl of potentialThumbnails) {
                    try {
                        await axios.head(thumbUrl);
                        bestThumbnailUrl = thumbUrl;
                        break;
                    } catch (e) { /* ignore */ }
                }
            }
            res.json({ 
                title: details.title, 
                subtitle: details.uploader || details.channel,
                thumbnail: bestThumbnailUrl, 
                platform: 'youtube' 
            });
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

            let bestMatch = null;
            let highestScore = -Infinity;

            for (const video of yt_videos) {
                let score = 0;
                const durationDiff = Math.abs(spotifyDurationSec - video.durationInSec);
                if (durationDiff > 10) continue; // Stricter pre-filter

                const videoTitle = video.title.toLowerCase();
                if (video.channel?.name.toLowerCase().includes(artistName.toLowerCase())) score += 20;
                if (videoTitle.includes("official audio")) score += 15;
                if (videoTitle.includes("lyrics")) score += 5;
                if (videoTitle.includes("live") || videoTitle.includes("cover") || videoTitle.includes("remix")) score -= 30;
                score -= durationDiff; // Penalize based on duration difference
                
                if (score > highestScore) {
                    highestScore = score;
                    bestMatch = video;
                }
            }
            if (!bestMatch) bestMatch = yt_videos[0]; // Fallback to top result if scoring fails
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using yt-dlp pipe.`);

        const ytdlpProcess = ytdlp.exec(videoUrl, {
            output: '-',
            format: 'bestaudio/best',
            noWarnings: true,
            noPlaylist: true,
            cookies: useCookies ? cookiesPath : undefined,
        });

        ffmpeg(ytdlpProcess.stdout)
            .inputFormat('webm')
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('error', (err, stdout, stderr) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                ytdlpProcess.kill();
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => {
                console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`);
            })
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.message);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

app.get('/api/download-image', async (req, res) => {
    // This endpoint remains the same
    // ...
});

// --- FINAL FIX: Removed the incorrect function call ---
app.listen(port, async () => {
    console.log(`Server is running on http://localhost:${port}`);
    // Pre-warm the Spotify token on startup to ensure it's ready for the first request.
    try {
        await getSpotifyToken(); 
    } catch (error) {
        console.error("Failed to pre-warm Spotify token on startup, will try again on first request.");
    }
    console.log("Server initialized and listening.");
});