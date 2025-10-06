const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec');
require('dotenv').config();
const axiosRetry = require('axios-retry');

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
  origin: 'https://wavcon.vercel.app'
}));

// --- FIX: Apply retry logic GLOBALLY to all axios requests ---
axiosRetry(axios, {
    retries: 3, // Retry up to 3 times
    retryDelay: (retryCount) => {
        console.log(`Request failed, attempt #${retryCount}. Retrying in ${retryCount * 2}s...`);
        return retryCount * 2000; // 2s, 4s, 6s
    },
    retryCondition: (error) => {
        // Retry on network errors or 5xx server errors
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && error.response.status >= 500);
    },
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
        throw new Error('Spotify credentials are not configured in the .env file.');
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
        const expiresIn = response.data.expires_in;
        spotifyToken.value = token;
        spotifyToken.expirationTime = Date.now() + (expiresIn - 60) * 1000;
        console.log('Successfully authenticated with Spotify.');
        return token;
    } catch (error) {
        console.error("!!! FAILED TO AUTHENTICATE WITH SPOTIFY AFTER RETRIES !!!");
        console.error(`Error details: ${error.message}`);
        throw new Error('Spotify authentication failed.');
    }
};

const findAppleMusicArtwork = async (track) => {
    const upc = track.album.external_ids?.upc;
    if (upc) {
        try {
            const lookupUrl = `https://itunes.apple.com/lookup?upc=${upc}&entity=album`;
            const response = await axios.get(lookupUrl);
            if (response.data.resultCount > 0) {
                const artworkUrl = response.data.results[0].artworkUrl100;
                if (artworkUrl) return artworkUrl.replace('100x100bb.jpg', '3000x3000.jpg');
            }
        } catch (error) { /* Fallback */ }
    }
    const albumName = track.album.name;
    const artistName = track.artists[0].name;
    try {
        const searchTerm = `${albumName} ${artistName}`;
        const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=album&limit=1`;
        const response = await axios.get(searchUrl);
        if (response.data.results.length > 0) {
            const artworkUrl = response.data.results[0].artworkUrl100;
            return artworkUrl.replace('100x100bb.jpg', '3000x3000.jpg');
        }
    } catch (error) { /* Fallback */ }
    return null;
};

const getSpotifyTrackDetails = async (trackId) => {
    const token = await getSpotifyToken();
    const trackUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
    const response = await axios.get(trackUrl, { headers: { 'Authorization': 'Bearer ' + token } });
    const track = response.data;
    const standardThumbnail = track.album.images[0]?.url;
    const highResPosterUrl = await findAppleMusicArtwork(track);

    return {
        title: track.name,
        subtitle: track.artists.map(a => a.name).join(', '),
        thumbnail: standardThumbnail,
        poster: highResPosterUrl,
        platform: 'spotify',
        duration_ms: track.duration_ms, 
    };
};

app.use(express.json());

app.post('/api/get-media-data', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    try {
        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) return res.status(400).json({ error: 'Invalid Spotify track URL.' });
            const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
            res.json(trackDetails);
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            const info = await play.video_info(url);
            const details = info.video_details;
            const videoId = details.id;
            let bestThumbnailUrl = details.thumbnails[details.thumbnails.length - 1]?.url;
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
            res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: bestThumbnailUrl, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- ERROR FETCHING MEDIA DATA ---", err.message);
        res.status(500).json({ error: 'Failed to fetch media data.' });
    }
});

app.post('/api/convert', async (req, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    try {
        let videoUrl, streamTitle;
        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) throw new Error('Invalid Spotify URL for conversion.');
            
            const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
            streamTitle = trackDetails.title;
            const spotifyDurationSec = trackDetails.duration_ms / 1000;
            const artistName = trackDetails.subtitle;
            const searchQuery = `${trackDetails.title} ${artistName}`;
            
            console.log(`Searching YouTube for: "${searchQuery}" (Original duration: ${spotifyDurationSec.toFixed(2)}s)`);
            const yt_videos = await play.search(searchQuery, { limit: 10 });
            
            if (yt_videos.length === 0) throw new Error('Could not find any videos on YouTube.');

            const DURATION_TOLERANCE_SEC = 7;
            const potentialMatches = yt_videos.filter(video =>
                Math.abs(spotifyDurationSec - video.durationInSec) < DURATION_TOLERANCE_SEC
            );

            let bestMatch = null;
            if (potentialMatches.length === 0) {
                 console.log("No matches within tolerance, finding closest duration from original list.");
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

                    if (video.channel && video.channel.name.toLowerCase().includes(artistNameLower)) score += 20;
                    if (videoTitle.includes("official audio")) score += 15;
                    if (videoTitle.includes("lyrics") || videoTitle.includes("lyric video")) score += 5;
                    if (videoTitle.includes(artistNameLower)) score += 5;
                    if (videoTitle.includes("live") || videoTitle.includes("cover") || videoTitle.includes("remix") || videoTitle.includes("reaction") || videoTitle.includes("afterlife") || videoTitle.includes("lofi")) score -= 30;
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
            const videoIdMatch = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11}).*/);
            if (!videoIdMatch || !videoIdMatch[1]) {
                throw new Error("Could not extract a valid YouTube video ID from the provided URL.");
            }
            const videoId = videoIdMatch[1];
            videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[FFMPEG] Starting .wav conversion for: ${sanitizedTitle}`);
        
        const stream = await play.stream(videoUrl, { 
            discordPlayerCompatibility: true
        });
        
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
        console.error("--- CONVERSION ERROR ---", err.message);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

app.get('/api/download-image', async (req, res) => {
    const { url, title, type } = req.query;
    if (!url || !title || !type) return res.status(400).json({ error: 'Missing parameters.' });
    try {
        const sanitizedTitle = title.replace(/[^a-z0-9_-\s]/gi, '_').trim();
        const suffix = type === 'poster' ? '_poster' : '_thumbnail';
        const filename = `${sanitizedTitle}${suffix}.jpg`;
        const response = await axios({ method: 'get', url: decodeURIComponent(url), responseType: 'stream' });
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'image/jpeg');
        response.data.pipe(res);
    } catch (err) {
        console.error("--- IMAGE DOWNLOAD PROXY ERROR ---", err.message);
        res.status(500).send('Failed to download image.');
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    getSpotifyToken().catch(() => {
        console.log("Could not pre-warm Spotify token.");
    });
});

