const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();
const { default: axiosRetry } = require('axios-retry'); // Keep for non-play-dl axios calls

ffmpeg.setFfmpegPath(ffmpegPath);
const app = express();
const port = process.env.PORT || 3001;

app.use(cors({
  origin: 'https://wavcon.vercel.app'
}));

// Apply retry logic GLOBALLY to other axios requests (e.g., Apple Music artwork)
axiosRetry(axios, {
    retries: 3,
    retryDelay: (retryCount) => {
        console.log(`Axios request failed, attempt #${retryCount}. Retrying in ${retryCount * 2}s...`);
        return retryCount * 2000;
    },
    retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && error.response.status >= 500);
    },
});

const cookiesPath = "./cookies.txt"; 
const useCookies = fs.existsSync(cookiesPath);

// --- NEW: Function to set play-dl's Spotify token ---
const setupPlayDlSpotifyToken = async () => {
    console.log('Setting up play-dl for Spotify authentication...');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        console.warn('Spotify credentials not found in environment. Spotify features may not work. Please check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Render environment variables.');
        return;
    }

    try {
        await play.setToken({
            spotify: {
                client_id: clientId,
                client_secret: clientSecret,
            }
        });
        console.log('play-dl successfully configured with Spotify credentials.');
    } catch (error) {
        console.error("!!! FAILED TO CONFIGURE PLAY-DL SPOTIFY TOKEN !!!");
        console.error("This may be due to incorrect credentials or persistent Spotify API issues.");
        console.error(`Error details: ${error.message}`);
        // Do not throw here, allow the server to start. Subsequent play-dl Spotify calls will then fail.
    }
};

// --- REMOVED: Custom spotifyToken cache and getSpotifyToken function ---

// --- UPDATED: getSpotifyTrackDetails to use play.spotify directly ---
const getSpotifyTrackDetails = async (trackId) => {
    try {
        // play.spotify() handles authentication and token refresh internally
        const track = await play.spotify(trackId); 
        if (!track) {
            throw new Error(`Could not find Spotify track details for ID: ${trackId}`);
        }

        const standardThumbnail = track.album.images[0]?.url;
        const highResPosterUrl = await findAppleMusicArtwork(track); // findAppleMusicArtwork uses global axios

        return {
            title: track.name,
            subtitle: track.artists.map(a => a.name).join(', '),
            thumbnail: standardThumbnail,
            poster: highResPosterUrl, // Will be null if not found
            platform: 'spotify',
            duration_ms: track.durationInMs, // play-dl gives durationInMs
        };
    } catch (error) {
        console.error(`Error fetching Spotify track details for ${trackId}:`, error.message);
        throw error; // Re-throw to be caught by the endpoint's try-catch
    }
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
        console.error("--- ERROR in /api/get-media-data ---");
        console.error(err); 
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
            const spotifyDurationSec = trackDetails.duration_ms / 1000; // duration_ms from play-dl
            const artistName = trackDetails.subtitle;
            const searchQuery = `${trackDetails.title} ${artistName}`;
            
            console.log(`Searching YouTube for: "${searchQuery}" (Original duration: ${spotifyDurationSec.toFixed(2)}s)`);
            const yt_videos = await play.search(searchQuery, { limit: 10 });
            
            if (yt_videos.length === 0) throw new Error('Could not find any videos on YouTube.');

            const DURATION_TOLERANCE_SEC = 7;
            const potentialMatches = yt_videos.filter(video => Math.abs(spotifyDurationSec - video.durationInSec) < DURATION_TOLERANCE_SEC);

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

                    if (video.channel?.name.toLowerCase().includes(artistNameLower)) score += 20;
                    if (videoTitle.includes("official audio")) score += 15;
                    if (videoTitle.includes("lyrics")) score += 5;
                    if (videoTitle.includes(artistNameLower)) score += 5;
                    if (videoTitle.includes("live") || videoTitle.includes("cover") || videoTitle.includes("remix")) score -= 30;
                    score -= durationDiff; 
                    
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
            videoUrl = `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
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
            .on('start', (cmd) => console.log(`[FFMPEG] Started with command: ${cmd}`))
            .on('error', (err, stdout, stderr) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                console.error("[FFMPEG STDERR]:", stderr);
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`))
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.message);
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

app.listen(port, async () => {
    console.log(`Server is running on http://localhost:${port}`);
    // --- NEW: Configure play-dl's Spotify token on startup ---
    await setupPlayDlSpotifyToken(); 
    console.log("Server initialized and listening.");
});