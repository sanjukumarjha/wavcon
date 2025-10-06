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
    retries: 3,
    retryDelay: (retryCount) => {
        console.log(`Request failed, attempt #${retryCount}. Retrying in ${retryCount * 2}s...`);
        return retryCount * 2000;
    },
    retryCondition: (error) => {
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

// --- FINAL, STABLE CONVERT ENDPOINT ---
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
            
            const yt_videos = await play.search(searchQuery, { limit: 10 });
            if (yt_videos.length === 0) throw new Error('Could not find any videos on YouTube.');

            let bestMatch = null;
            let highestScore = -Infinity;

            for (const video of yt_videos) {
                let score = 0;
                const durationDiff = Math.abs(spotifyDurationSec - video.durationInSec);
                if (durationDiff > 7) continue; 

                const videoTitle = video.title.toLowerCase();
                const artistNameLower = artistName.toLowerCase();
                if (video.channel && video.channel.name.toLowerCase().includes(artistNameLower)) score += 20;
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
            if (!bestMatch) {
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
            }
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');
        
        console.log(`[CONVERT] Starting conversion for: ${sanitizedTitle} using ytdlp pipe.`);

        const ytdlpProcess = ytdlp.exec(videoUrl, {
            output: '-',
            format: 'bestaudio/best',
            noWarnings: true,
            noPlaylist: true,
            cookies: useCookies ? cookiesPath : undefined,
        });

        ffmpeg(ytdlpProcess.stdout)
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
            })
            .pipe(res, { end: true });

    } catch (err) {
        console.error("--- TOP LEVEL CONVERSION ERROR ---", err.message);
        if (!res.headersSent) res.status(500).send('An error occurred during conversion.');
    }
});

app.get('/api/download-image', async (req, res) => {
    // This endpoint remains the same
    //...
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    getSpotifyToken().catch(() => {
        console.log("Could not pre-warm Spotify token.");
    });
});

