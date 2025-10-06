const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec'); // We will now use this for YouTube metadata too
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
    try {
        const fullTrackUrl = `https://open.spotify.com/track/${trackId}`;
        const track = await play.spotify(fullTrackUrl); 
        
        if (!track) {
            throw new Error(`Could not find Spotify track details for ID: ${trackId}`);
        }

        return {
            title: track.name,
            subtitle: track.artists.map(a => a.name).join(', '),
            thumbnail: track.album?.images[0]?.url,
            poster: await findAppleMusicArtwork(track),
            platform: 'spotify',
            duration_ms: track.durationInMs,
        };
    } catch (error) {
        console.error(`Error in getSpotifyTrackDetails for ${trackId}:`, error.message);
        throw error;
    }
};

app.use(express.json());

// --- UPDATED /api/get-media-data ENDPOINT: Use yt-dlp for YouTube metadata ---
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
            // --- FIX: Use the more robust ytdlp for fetching YouTube metadata ---
            console.log(`Fetching YouTube metadata with ytdlp for: ${url}`);
            const details = await ytdlp(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                noPlaylist: true,
                cookies: useCookies ? cookiesPath : undefined,
            });

            const videoId = details.id;
            let bestThumbnailUrl = details.thumbnail; // yt-dlp provides a good default thumbnail

            // Still try to find max resolution versions (maxresdefault, hq720) if available
            if (videoId) {
                const potentialThumbnails = [`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hq720.jpg`];
                for (const thumbUrl of potentialThumbnails) {
                    try {
                        await axios.head(thumbUrl); // Check if the URL exists
                        bestThumbnailUrl = thumbUrl;
                        break;
                    } catch (e) { /* Fallback to existing bestThumbnailUrl if head request fails */ }
                }
            }
            res.json({ 
                title: details.title, 
                subtitle: details.uploader || details.channel, // yt-dlp uses 'uploader' or 'channel'
                thumbnail: bestThumbnailUrl, 
                platform: 'youtube' 
            });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("--- FATAL ERROR in /api/get-media-data ---");
        console.error(err.stack); // Log the full stack trace for better debugging
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
            videoUrl = url; // Use the provided YouTube URL for direct conversion
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using yt-dlp pipe.`);

        // Use yt-dlp-exec as a child process and pipe its stdout to ffmpeg
        const ytdlpArgs = [
            videoUrl,
            '-f', 'bestaudio', // Request the best audio format
            '-o', '-',         // Output to stdout (pipe)
            '--no-warnings',
            '--no-playlist',
            '--no-check-certificates',
        ];
        if (useCookies) {
            ytdlpArgs.push('--cookies', cookiesPath);
        }

        const ytdlpProcess = ytdlp.exec(ytdlpArgs, {
            stdio: ['ignore', 'pipe', 'inherit'], // Pipe stdout, inherit stderr for debugging
            shell: true // Important for Windows; also good for Render to ensure yt-dlp is found
        });

        ffmpeg(ytdlpProcess.stdout)
            .inputFormat('webm') // Explicitly tell ffmpeg to expect webm or similar (YouTube's best audio is often webm)
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('start', (cmd) => console.log(`[FFMPEG] Started with command: ${cmd}`))
            .on('error', (err, stdout, stderr) => {
                console.error("--- FFMPEG ERROR ---", err.message);
                console.error("[FFMPEG STDERR]:", stderr);
                ytdlpProcess.kill();
                if (!res.headersSent) res.status(500).send('Error during conversion');
            })
            .on('end', () => {
                console.log(`[FFMPEG] Finished conversion for: ${sanitizedTitle}`);
                ytdlpProcess.kill();
            })
            .pipe(res, { end: true });

        ytdlpProcess.on('error', (err) => {
            console.error("--- YTDLP PROCESS ERROR ---", err.message);
            if (!res.headersSent) res.status(500).send('Error during audio extraction from yt-dlp.');
        });
        ytdlpProcess.on('close', (code) => {
            if (code !== 0 && code !== null && !ytdlpProcess.killed) { 
                console.error(`--- YTDLP PROCESS EXITED ABNORMALLY WITH CODE ${code} ---`);
                if (!res.headersSent) res.status(500).send('Error during audio extraction from yt-dlp.');
            }
        });

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
    await setupPlayDlSpotifyToken(); 
    console.log("Server initialized and listening.");
});

