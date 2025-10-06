const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const play = require('play-dl');
const fs = require('fs');
const axios = require('axios');
const ytdlp = require('yt-dlp-exec');
require('dotenv').config();

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const port = process.env.PORT || 3001; // Use Render port

// Use relative path for cookies (optional)
const cookiesPath = "./cookies.txt";
const useCookies = fs.existsSync(cookiesPath);

let spotifyToken = {
    value: null,
    expirationTime: 0,
};

const getSpotifyToken = async () => {
    if (spotifyToken.value && Date.now() < spotifyToken.expirationTime) return spotifyToken.value;

    console.log('Authenticating with Spotify...');
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) throw new Error('Spotify credentials missing.');

    const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        method: 'post',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: 'grant_type=client_credentials'
    };

    try {
        const response = await axios(authOptions);
        const token = response.data.access_token;
        const expiresIn = response.data.expires_in;
        spotifyToken.value = token;
        spotifyToken.expirationTime = Date.now() + (expiresIn - 60) * 1000;
        console.log('Spotify authenticated.');
        return token;
    } catch (err) {
        console.error("Spotify authentication failed", err.message);
        throw err;
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
        } catch { }
    }

    const albumName = track.album.name;
    const artistName = track.artists[0].name;
    try {
        const searchUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(albumName + ' ' + artistName)}&entity=album&limit=1`;
        const response = await axios.get(searchUrl);
        if (response.data.results.length > 0) {
            const artworkUrl = response.data.results[0].artworkUrl100;
            return artworkUrl.replace('100x100bb.jpg', '3000x3000.jpg');
        }
    } catch { }
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

app.use(cors());
app.use(express.json());

// --- Get Media Data ---
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
            const potentialThumbnails = [`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hq720.jpg`];
            for (const thumbUrl of potentialThumbnails) {
                try { await axios.head(thumbUrl); bestThumbnailUrl = thumbUrl; break; } catch { }
            }
            res.json({ title: details.title, subtitle: details.channel?.name, thumbnail: bestThumbnailUrl, platform: 'youtube' });
        } else {
            res.status(400).json({ error: 'Invalid or unsupported URL.' });
        }
    } catch (err) {
        console.error("ERROR FETCHING MEDIA DATA:", err.message);
        res.status(500).json({ error: 'Failed to fetch media data.' });
    }
});

// --- Convert Endpoint ---
app.post('/api/convert', async (req, res) => {
    const { url, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });

    try {
        let videoUrl, streamTitle;

        if (url.includes('spotify.com/track/')) {
            const trackIdMatch = url.match(/track\/([a-zA-Z0-9]+)/);
            if (!trackIdMatch) throw new Error('Invalid Spotify URL.');

            const trackDetails = await getSpotifyTrackDetails(trackIdMatch[1]);
            streamTitle = trackDetails.title;
            const spotifyDurationSec = trackDetails.duration_ms / 1000;
            const artistName = trackDetails.subtitle;

            const primarySearchQuery = `${trackDetails.title} ${artistName}`;
            const officialAudioQuery = `${primarySearchQuery} official audio`;
            console.log(`Searching YouTube for: "${officialAudioQuery}"`);

            let yt_videos = await play.search(officialAudioQuery, { limit: 3 });
            if (yt_videos.length === 0) yt_videos = await play.search(primarySearchQuery, { limit: 5 });
            if (yt_videos.length === 0) throw new Error('Could not find a matching video.');

            // --- Simple best match logic ---
            let bestMatch = yt_videos[0];
            videoUrl = bestMatch.url;
        } else {
            streamTitle = title;
            videoUrl = url;
        }

        console.log(`Fetching direct audio URL with ytdlp for: ${videoUrl}`);
        const audioInfo = await ytdlp(videoUrl, { dumpSingleJson: true, format: 'bestaudio/best', cookies: useCookies ? cookiesPath : undefined });
        if (!audioInfo.url) throw new Error('ytdlp failed.');

        const sanitizedTitle = (streamTitle || 'audio').replace(/[^a-z0-9_-\s]/gi, '_').trim();
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizedTitle}.wav"`);
        res.setHeader('Content-Type', 'audio/wav');

        console.log(`[FFMPEG] Starting .wav conversion for: ${sanitizedTitle}`);
        ffmpeg(audioInfo.url)
            .audioBitrate(128)
            .toFormat('wav')
            .audioFrequency(48000)
            .on('error', (err) => console.error("FFMPEG ERROR:", err.message))
            .on('end', () => console.log(`[FFMPEG] Finished conversion: ${sanitizedTitle}`))
            .pipe(res, { end: true });

    } catch (err) {
        console.error("CONVERSION ERROR:", err.message);
        if (!res.headersSent) res.status(500).send('Conversion failed.');
    }
});

// --- Download Image Proxy ---
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
        console.error("IMAGE DOWNLOAD ERROR:", err.message);
        res.status(500).send('Failed to download image.');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    getSpotifyToken().catch(() => console.log("Could not pre-warm Spotify token."));
});
