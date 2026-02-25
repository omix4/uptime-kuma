/**
 * Stremio Addon Monitor for Uptime Kuma
 * Tests addons by actually querying them for streams using Cinemeta catalogs
 */

const axios = require("axios");
const { log, UP, DOWN } = require("../src/util");

// Cinemeta base URLs for catalog fetching
const CINEMETA_MOVIE_URL = "https://v3-cinemeta.strem.io/catalog/movie/top.json";
const CINEMETA_SERIES_URL = "https://v3-cinemeta.strem.io/catalog/series/top.json";

/**
 * Time a function execution and return result with timing
 */
async function timedExecution(fn) {
    const startTime = Date.now();
    try {
        const result = await fn();
        const duration = Date.now() - startTime;
        return { success: true, data: result, duration, error: null };
    } catch (error) {
        const duration = Date.now() - startTime;
        return { success: false, data: null, duration, error: error.message };
    }
}

class StremioAddonMonitor {
    static type = "stremio";
    static name = "Stremio Addon"; static defaultPort = 80;

    /**
     * Get random items from Cinemeta catalog
     */
    async getRandomCinemetaItems() {
        return timedExecution(async () => {
            const [movieRes, seriesRes] = await Promise.all([
                axios.get(CINEMETA_MOVIE_URL, { timeout: 15000, maxRedirects: 5 }),
                axios.get(CINEMETA_SERIES_URL, { timeout: 15000, maxRedirects: 5 })
            ]);
            
            const movies = movieRes.data?.metas || [];
            const series = seriesRes.data?.metas || [];

            if (movies.length === 0 || series.length === 0) {
                throw new Error("Empty catalog response");
            }

            const randomMovie = movies[Math.floor(Math.random() * movies.length)];
            const randomSeries = series[Math.floor(Math.random() * series.length)];

            return {
                movie: randomMovie,
                series: randomSeries
            };
        });
    }

    /**
     * Query addon for streams - handles both movies and series
     */
    async queryAddonForStreams(addonUrl, type, id) {
        return timedExecution(async () => {
            const streamUrl = `${addonUrl.replace(/\/$/, "")}/stream/${type}/${id}.json`;
            const response = await axios.get(streamUrl, {
                timeout: 30000,
                headers: {
                    "User-Agent": "Uptime-Kuma-Stremio-Monitor/1.0"
                }
            });
            return response.data;
        });
    }

    /**
     * Query addon meta endpoint to get episodes for series
     */
    async queryAddonMeta(addonUrl, type, id) {
        return timedExecution(async () => {
            const metaUrl = `${addonUrl.replace(/\/$/, "")}/meta/${type}/${id}.json`;
            const response = await axios.get(metaUrl, {
                timeout: 15000,
                headers: {
                    "User-Agent": "Uptime-Kuma-Stremio-Monitor/1.0"
                }
            });
            return response.data;
        });
    }

    /**
     * Analyze stream quality distribution
     */
    analyzeStreamQuality(streams) {
        if (!streams || streams.length === 0) {
            return { qualities: [], total: 0, has4k: false, hasHDR: false };
        }

        const qualityMap = {};
        let has4k = false;
        let hasHDR = false;

        for (const stream of streams) {
            const title = stream.title || "";
            const name = stream.name || "";
            const combined = `${title} ${name}`.toLowerCase();

            let quality = "unknown";
            if (combined.includes("4k") || combined.includes("2160")) {
                quality = "4K";
                has4k = true;
            } else if (combined.includes("1080")) {
                quality = "1080p";
            } else if (combined.includes("720")) {
                quality = "720p";
            } else if (combined.includes("480")) {
                quality = "480p";
            }

            if (combined.includes("hdr") || combined.includes("dolby") || combined.includes("dv")) {
                hasHDR = true;
            }

            qualityMap[quality] = (qualityMap[quality] || 0) + 1;
        }

        return {
            qualities: Object.entries(qualityMap).map(([q, count]) => ({ quality: q, count })),
            total: streams.length,
            has4k,
            hasHDR
        };
    }

    /**
     * Main check function - tests addon by querying streams
     */
    async check(monitor, heartbeat, server) {
        const addonUrl = monitor.url;
        
        const results = {
            movie: null,
            series: null,
            overall: DOWN,
            msg: "",
            timing: {
                total: 0,
                cinemeta: 0,
                movieQuery: 0,
                seriesQuery: 0,
                metaQuery: 0
            },
            addon: {
                url: addonUrl,
                testedAt: new Date().toISOString()
            }
        };

        const overallStart = Date.now();

        try {
            // Get random items from Cinemeta with timing
            const cinemetaResult = await this.getRandomCinemetaItems();
            results.timing.cinemeta = cinemetaResult.duration;

            if (!cinemetaResult.success) {
                throw new Error(`Failed to fetch Cinemeta catalogs: ${cinemetaResult.error}`);
            }

            const items = cinemetaResult.data;

            if (!items.movie || !items.series) {
                throw new Error("Failed to get Cinemeta catalogs - empty response");
            }

            // Test movie streams - use imdb_id for movies
            const movieId = items.movie.imdb_id || items.movie.id;
            const movieQueryResult = await this.queryAddonForStreams(addonUrl, "movie", movieId);
            results.timing.movieQuery = movieQueryResult.duration;

            if (movieQueryResult.success && movieQueryResult.data) {
                const qualityInfo = this.analyzeStreamQuality(movieQueryResult.data.streams);
                results.movie = {
                    id: movieId,
                    name: items.movie.name,
                    poster: items.movie.poster,
                    year: items.movie.year,
                    streams: movieQueryResult.data.streams?.length || 0,
                    streamDetails: movieQueryResult.data.streams || [],
                    quality: qualityInfo,
                    working: (movieQueryResult.data.streams?.length || 0) > 0,
                    responseTime: movieQueryResult.duration,
                    error: null
                };
            } else {
                results.movie = {
                    id: movieId,
                    name: items.movie.name,
                    poster: items.movie.poster,
                    year: items.movie.year,
                    streams: 0,
                    streamDetails: [],
                    quality: { qualities: [], total: 0, has4k: false, hasHDR: false },
                    working: false,
                    responseTime: movieQueryResult.duration,
                    error: movieQueryResult.error
                };
            }

            // Test series streams
            const seriesId = items.series.imdb_id || items.series.id;
            
            // First get meta to find episode id
            const metaQueryResult = await this.queryAddonMeta(addonUrl, "series", seriesId);
            results.timing.metaQuery = metaQueryResult.duration;

            if (metaQueryResult.success && metaQueryResult.data) {
                const episodes = metaQueryResult.data?.meta?.videos || [];
                if (episodes.length > 0) {
                    const episode = episodes[0];
                    const episodeQueryResult = await this.queryAddonForStreams(addonUrl, "series", episode.id);
                    results.timing.seriesQuery = episodeQueryResult.duration;

                    if (episodeQueryResult.success && episodeQueryResult.data) {
                        const qualityInfo = this.analyzeStreamQuality(episodeQueryResult.data.streams);
                        results.series = {
                            id: episode.id,
                            seriesId: seriesId,
                            name: items.series.name,
                            poster: items.series.poster,
                            episode: episode.title,
                            season: episode.season,
                            episodeNum: episode.episode,
                            streams: episodeQueryResult.data.streams?.length || 0,
                            streamDetails: episodeQueryResult.data.streams || [],
                            quality: qualityInfo,
                            working: (episodeQueryResult.data.streams?.length || 0) > 0,
                            responseTime: episodeQueryResult.duration,
                            error: null
                        };
                    } else {
                        results.series = {
                            id: episode.id,
                            seriesId: seriesId,
                            name: items.series.name,
                            poster: items.series.poster,
                            episode: episode.title,
                            season: episode.season,
                            episodeNum: episode.episode,
                            streams: 0,
                            streamDetails: [],
                            quality: { qualities: [], total: 0, has4k: false, hasHDR: false },
                            working: false,
                            responseTime: episodeQueryResult.duration,
                            error: episodeQueryResult.error
                        };
                    }
                } else {
                    // No episodes, try series-level stream
                    const seriesQueryResult = await this.queryAddonForStreams(addonUrl, "series", seriesId);
                    results.timing.seriesQuery = seriesQueryResult.duration;

                    if (seriesQueryResult.success && seriesQueryResult.data) {
                        const qualityInfo = this.analyzeStreamQuality(seriesQueryResult.data.streams);
                        results.series = {
                            id: seriesId,
                            seriesId: seriesId,
                            name: items.series.name,
                            poster: items.series.poster,
                            streams: seriesQueryResult.data.streams?.length || 0,
                            streamDetails: seriesQueryResult.data.streams || [],
                            quality: qualityInfo,
                            working: (seriesQueryResult.data.streams?.length || 0) > 0,
                            responseTime: seriesQueryResult.duration,
                            error: null
                        };
                    } else {
                        results.series = {
                            id: seriesId,
                            seriesId: seriesId,
                            name: items.series.name,
                            poster: items.series.poster,
                            streams: 0,
                            streamDetails: [],
                            quality: { qualities: [], total: 0, has4k: false, hasHDR: false },
                            working: false,
                            responseTime: seriesQueryResult.duration,
                            error: seriesQueryResult.error
                        };
                    }
                }
            } else {
                // Meta failed, try direct series stream
                const seriesQueryResult = await this.queryAddonForStreams(addonUrl, "series", seriesId);
                results.timing.seriesQuery = seriesQueryResult.duration;

                if (seriesQueryResult.success && seriesQueryResult.data) {
                    const qualityInfo = this.analyzeStreamQuality(seriesQueryResult.data.streams);
                    results.series = {
                        id: seriesId,
                        seriesId: seriesId,
                        name: items.series.name,
                        poster: items.series.poster,
                        streams: seriesQueryResult.data.streams?.length || 0,
                        streamDetails: seriesQueryResult.data.streams || [],
                        quality: qualityInfo,
                        working: (seriesQueryResult.data.streams?.length || 0) > 0,
                        responseTime: seriesQueryResult.duration,
                        error: null
                    };
                } else {
                    results.series = {
                        id: seriesId,
                        seriesId: seriesId,
                        name: items.series.name,
                        poster: items.series.poster,
                        streams: 0,
                        streamDetails: [],
                        quality: { qualities: [], total: 0, has4k: false, hasHDR: false },
                        working: false,
                        responseTime: seriesQueryResult.duration,
                        error: seriesQueryResult.error
                    };
                }
            }

            // Calculate total timing
            results.timing.total = Date.now() - overallStart;

            // Determine overall status
            const movieWorking = results.movie?.working;
            const seriesWorking = results.series?.working;

            // Calculate total streams
            const totalStreams = (results.movie?.streams || 0) + (results.series?.streams || 0);
            results.totalStreams = totalStreams;

            if (movieWorking || seriesWorking) {
                results.overall = UP;
                heartbeat.status = UP;
                const movieStreams = results.movie?.streams || 0;
                const seriesStreams = results.series?.streams || 0;
                results.msg = `✓ Working - Movie: ${movieStreams} streams, Series: ${seriesStreams} streams (${results.timing.total}ms total)`;
            } else {
                results.overall = DOWN;
                heartbeat.status = DOWN;
                results.msg = "✗ Not working - No streams returned from addon";
            }

            // Set heartbeat response
            heartbeat.response = results;
            heartbeat.ping = results.timing.total;
            
            log.debug("monitor", `[StremioAddon] Check complete: ${results.msg}`);

        } catch (error) {
            results.timing.total = Date.now() - overallStart;
            results.msg = `Error: ${error.message}`;
            results.overall = DOWN;
            heartbeat.status = DOWN;
            heartbeat.response = results;
            heartbeat.ping = results.timing.total;
            
            throw error;
        }
    }
}

module.exports = {
    StremioAddonMonitor
};
