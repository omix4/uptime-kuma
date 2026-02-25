const NotificationProvider = require("./notification-provider");
const axios = require("axios");
const { DOWN, UP } = require("../../src/util");

class Discord extends NotificationProvider {
    name = "discord";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";

        // Discord Message Flags
        // @see https://discord.com/developers/docs/resources/message#message-object-message-flags
        // This message will not trigger push and desktop notifications
        const SUPPRESS_NOTIFICATIONS_FLAG = 1 << 12;

        try {
            let config = this.getAxiosConfigWithProxy({});
            const discordDisplayName = notification.discordUsername || "Uptime Kuma";
            const webhookUrl = new URL(notification.discordWebhookUrl);
            if (notification.discordChannelType === "postToThread") {
                webhookUrl.searchParams.append("thread_id", notification.threadId);
            }

            // Check if the webhook has an avatar
            let webhookHasAvatar = true;
            try {
                const webhookInfo = await axios.get(webhookUrl.toString(), config);
                webhookHasAvatar = !!webhookInfo.data.avatar;
            } catch (e) {
                // If we can't verify, we assume he has an avatar to avoid forcing the default avatar
                webhookHasAvatar = true;
            }

            const messageFormat =
                notification.discordMessageFormat || (notification.discordUseMessageTemplate ? "custom" : "normal");

            // If heartbeatJSON is null, assume we're testing.
            if (heartbeatJSON == null) {
                let content = msg;
                if (messageFormat === "minimalist") {
                    content = "Test: " + msg;
                } else if (messageFormat === "custom") {
                    const customMessage = notification.discordMessageTemplate?.trim() || "";
                    if (customMessage !== "") {
                        content = await this.renderTemplate(customMessage, msg, monitorJSON, heartbeatJSON);
                    }
                }
                let discordtestdata = {
                    username: discordDisplayName,
                    content: content,
                };
                if (!webhookHasAvatar) {
                    discordtestdata.avatar_url = "https://github.com/louislam/uptime-kuma/raw/master/public/icon.png";
                }
                if (notification.discordChannelType === "createNewForumPost") {
                    discordtestdata.thread_name = notification.postName;
                }
                if (notification.discordSuppressNotifications) {
                    discordtestdata.flags = SUPPRESS_NOTIFICATIONS_FLAG;
                }
                await axios.post(webhookUrl.toString(), discordtestdata, config);
                return okMsg;
            }

            // If heartbeatJSON is not null, we go into the normal alerting loop.
            let addess = this.extractAddress(monitorJSON);

            // Minimalist: status + name only (is down / is up; no "back up" — may be first trigger)
            if (messageFormat === "minimalist") {
                const content =
                    heartbeatJSON["status"] === DOWN
                        ? "🔴 " + monitorJSON["name"] + " is down."
                        : "🟢 " + monitorJSON["name"] + " is up.";
                let payload = {
                    username: discordDisplayName,
                    content: content,
                };
                if (!webhookHasAvatar) {
                    payload.avatar_url = "https://github.com/louislam/uptime-kuma/raw/master/public/icon.png";
                }
                if (notification.discordChannelType === "createNewForumPost") {
                    payload.thread_name = notification.postName;
                }
                if (notification.discordSuppressNotifications) {
                    payload.flags = SUPPRESS_NOTIFICATIONS_FLAG;
                }
                await axios.post(webhookUrl.toString(), payload, config);
                return okMsg;
            }

            // Custom template: send only content (no embeds)
            const useCustomTemplate =
                messageFormat === "custom" && (notification.discordMessageTemplate?.trim() || "") !== "";
            if (useCustomTemplate) {
                const content = await this.renderTemplate(
                    notification.discordMessageTemplate.trim(),
                    msg,
                    monitorJSON,
                    heartbeatJSON
                );
                let payload = {
                    username: discordDisplayName,
                    content: content,
                };
                if (!webhookHasAvatar) {
                    payload.avatar_url = "https://github.com/louislam/uptime-kuma/raw/master/public/icon.png";
                }
                if (notification.discordChannelType === "createNewForumPost") {
                    payload.thread_name = notification.postName;
                }
                if (notification.discordSuppressNotifications) {
                    payload.flags = SUPPRESS_NOTIFICATIONS_FLAG;
                }
                await axios.post(webhookUrl.toString(), payload, config);
                return okMsg;
            }

            if (heartbeatJSON["status"] === DOWN) {
                const wentOfflineTimestamp = Math.floor(new Date(heartbeatJSON["time"]).getTime() / 1000);

                // Check if this is a Stremio addon monitor
                const isStremio = heartbeatJSON["monitorType"] === "stremio";
                
                // Parse response data
                let responseData = null;
                if (heartbeatJSON["response"]) {
                    try {
                        responseData = typeof heartbeatJSON["response"] === 'string' 
                            ? JSON.parse(heartbeatJSON["response"]) 
                            : heartbeatJSON["response"];
                    } catch (e) {
                        responseData = null;
                    }
                }

                let embedFields = [];
                
                // Build Stremio embed with detailed fields
                if (isStremio && responseData) {
                    const movieStreams = responseData.movie?.streams || 0;
                    const seriesStreams = responseData.series?.streams || 0;
                    const totalStreams = responseData.totalStreams || 0;
                    
                    embedFields = [
                        {
                            name: "📋 Manifest",
                            value: responseData.addon?.url || monitorJSON["url"] || "N/A",
                            inline: false
                        },
                        {
                            name: "🎬 Movie Search",
                            value: responseData.movie ? `**${responseData.movie.name}**\n${responseData.movie.id}` : "N/A",
                            inline: true
                        },
                        {
                            name: "✅ Movie",
                            value: movieStreams > 0 ? `✓ Valid (${movieStreams})` : "✗ Failed",
                            inline: true
                        },
                        {
                            name: "📺 Series Search",
                            value: responseData.series ? `**${responseData.series.name}**\n${responseData.series.id}` : "N/A",
                            inline: true
                        },
                        {
                            name: "✅ Series",
                            value: seriesStreams > 0 ? `✓ Valid (${seriesStreams})` : "✗ Failed",
                            inline: true
                        },
                        {
                            name: "🔥 Total Streams",
                            value: `**${totalStreams}**`,
                            inline: true
                        },
                        {
                            name: "⏱️ Latency",
                            value: heartbeatJSON["ping"] ? `${heartbeatJSON["ping"]} ms` : "N/A",
                            inline: true
                        },
                        {
                            name: "🕐 Tested At",
                            value: heartbeatJSON["localDateTime"] || new Date(heartbeatJSON["time"]).toLocaleString(),
                            inline: true
                        }
                    ];
                } else {
                    // Default non-Stremio embed
                    embedFields = [
                        {
                            name: "Service Name",
                            value: monitorJSON["name"],
                        },
                        ...(!notification.disableUrl && addess
                            ? [
                                  {
                                      name: monitorJSON["type"] === "push" ? "Service Type" : "Service URL",
                                      value: addess,
                                  },
                              ]
                            : []),
                        {
                            name: "Went Offline",
                            value: `<t:${wentOfflineTimestamp}:F>`,
                        },
                        {
                            name: `Time (${heartbeatJSON["timezone"]})`,
                            value: heartbeatJSON["localDateTime"],
                        },
                        {
                            name: "Error",
                            value: heartbeatJSON["msg"] == null ? "N/A" : heartbeatJSON["msg"],
                        },
                    ];
                }

                // Determine color and title
                let embedColor = 16711680; // Red
                let embedTitle = "❌ " + monitorJSON["name"] + " is DOWN";
                
                if (isStremio && responseData) {
                    const totalStreams = responseData.totalStreams || 0;
                    embedColor = totalStreams > 0 ? 65280 : 16711680; // Green if streams, red if not
                    embedTitle = totalStreams > 0 
                        ? `✅ ${monitorJSON["name"]} - ${totalStreams} Streams` 
                        : `❌ ${monitorJSON["name"]} - No Streams`;
                }

                let discorddowndata = {
                    username: discordDisplayName,
                    embeds: [
                        {
                            title: embedTitle,
                            color: embedColor,
                            timestamp: heartbeatJSON["time"],
                            fields: embedFields,
                        },
                    ],
                };
                if (!webhookHasAvatar) {
                    discorddowndata.avatar_url = "https://github.com/louislam/uptime-kuma/raw/master/public/icon.png";
                }
                if (notification.discordChannelType === "createNewForumPost") {
                    discorddowndata.thread_name = notification.postName;
                }
                if (notification.discordPrefixMessage) {
                    discorddowndata.content = notification.discordPrefixMessage;
                }
                if (notification.discordSuppressNotifications) {
                    discorddowndata.flags = SUPPRESS_NOTIFICATIONS_FLAG;
                }

                await axios.post(webhookUrl.toString(), discorddowndata, config);
                return okMsg;
            } else if (heartbeatJSON["status"] === UP) {
                const backOnlineTimestamp = Math.floor(new Date(heartbeatJSON["time"]).getTime() / 1000);
                let downtimeDuration = null;
                let wentOfflineTimestamp = null;
                if (heartbeatJSON["lastDownTime"]) {
                    wentOfflineTimestamp = Math.floor(new Date(heartbeatJSON["lastDownTime"]).getTime() / 1000);
                    downtimeDuration = this.formatDuration(backOnlineTimestamp - wentOfflineTimestamp);
                }

                // Check if this is a Stremio addon monitor
                const isStremio = heartbeatJSON["monitorType"] === "stremio";
                
                // Parse response data
                let responseData = null;
                if (heartbeatJSON["response"]) {
                    try {
                        responseData = typeof heartbeatJSON["response"] === 'string' 
                            ? JSON.parse(heartbeatJSON["response"]) 
                            : heartbeatJSON["response"];
                    } catch (e) {
                        responseData = null;
                    }
                }

                let embedFields = [];
                let embedTitle = "✅ Your service " + monitorJSON["name"] + " is up! ✅";
                let embedColor = 65280; // Green
                
                // Build Stremio embed with detailed fields
                if (isStremio && responseData) {
                    const movieStreams = responseData.movie?.streams || 0;
                    const seriesStreams = responseData.series?.streams || 0;
                    const totalStreams = responseData.totalStreams || 0;
                    
                    embedFields = [
                        {
                            name: "📋 Manifest",
                            value: responseData.addon?.url || monitorJSON["url"] || "N/A",
                            inline: false
                        },
                        {
                            name: "🎬 Movie",
                            value: responseData.movie ? `**${responseData.movie.name}**\n${movieStreams} streams` : "N/A",
                            inline: true
                        },
                        {
                            name: "📺 Series",
                            value: responseData.series ? `**${responseData.series.name}**\n${seriesStreams} streams` : "N/A",
                            inline: true
                        },
                        {
                            name: "🔥 Total Streams",
                            value: `**${totalStreams}**`,
                            inline: true
                        },
                        {
                            name: "⏱️ Latency",
                            value: heartbeatJSON["ping"] ? `${heartbeatJSON["ping"]} ms` : "N/A",
                            inline: true
                        }
                    ];
                    
                    embedTitle = `✅ ${monitorJSON["name"]} - ${totalStreams} Streams Found`;
                } else {
                    // Default non-Stremio embed
                    embedFields = [
                        {
                            name: "Service Name",
                            value: monitorJSON["name"],
                        },
                        ...(!notification.disableUrl && addess
                            ? [
                                  {
                                      name: monitorJSON["type"] === "push" ? "Service Type" : "Service URL",
                                      value: addess,
                                  },
                              ]
                            : []),
                        ...(wentOfflineTimestamp
                            ? [
                                  {
                                      name: "Went Offline",
                                      value: `<t:${wentOfflineTimestamp}:F>`,
                                  },
                              ]
                            : []),
                        ...(downtimeDuration
                            ? [
                                  {
                                      name: "Downtime Duration",
                                      value: downtimeDuration,
                                  },
                              ]
                            : []),
                        {
                            name: `Time (${heartbeatJSON["timezone"]})`,
                            value: heartbeatJSON["localDateTime"],
                        },
                        ...(heartbeatJSON["ping"] != null
                            ? [
                                  {
                                      name: "Ping",
                                      value: heartbeatJSON["ping"] + " ms",
                                  },
                              ]
                            : []),
                    ];
                }

                let discordupdata = {
                    username: discordDisplayName,
                    embeds: [
                        {
                            title: embedTitle,
                            color: embedColor,
                            timestamp: heartbeatJSON["time"],
                            fields: embedFields,
                        },
                    ],
                };
                if (!webhookHasAvatar) {
                    discordupdata.avatar_url = "https://github.com/louislam/uptime-kuma/raw/master/public/icon.png";
                }

                if (notification.discordChannelType === "createNewForumPost") {
                    discordupdata.thread_name = notification.postName;
                }

                if (notification.discordPrefixMessage) {
                    discordupdata.content = notification.discordPrefixMessage;
                }
                if (notification.discordSuppressNotifications) {
                    discordupdata.flags = SUPPRESS_NOTIFICATIONS_FLAG;
                }

                await axios.post(webhookUrl.toString(), discordupdata, config);
                return okMsg;
            }
        } catch (error) {
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Format duration as human-readable string (e.g., "1h 23m", "45m 30s")
     * TODO: Update below to `Intl.DurationFormat("en", { style: "short" }).format(duration)` once we are on a newer node version
     * @param {number} timeInSeconds The time in seconds to format a duration for
     * @returns {string} The formatted duration
     */
    formatDuration(timeInSeconds) {
        const hours = Math.floor(timeInSeconds / 3600);
        const minutes = Math.floor((timeInSeconds % 3600) / 60);
        const seconds = timeInSeconds % 60;

        const durationParts = [];
        if (hours > 0) {
            durationParts.push(`${hours}h`);
        }
        if (minutes > 0) {
            durationParts.push(`${minutes}m`);
        }
        if (seconds > 0 && hours === 0) {
            // Only show seconds if less than an hour
            durationParts.push(`${seconds}s`);
        }

        return durationParts.length > 0 ? durationParts.join(" ") : "0s";
    }
}

module.exports = Discord;
