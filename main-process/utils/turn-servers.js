const axios = require('axios');
const config = require('../../config');

/**
 * Получает список TURN серверов с бекенда с авторизацией
 * @param {string} authToken - JWT токен пользователя
 * @returns {Promise<{iceServers: string[], cached: boolean, timestamp: number, expiresAt: number, serverCount: number}>}
 */
async function fetchTurnServersFromBackend(authToken) {
    if (!authToken) throw new Error('Authorization token is required');
    const url = `https://${config.serverAddress}/api/turn-cloudflare`;
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${authToken}`
            },
            timeout: 5000
        });
        if (response.data && response.data.success) {
            return response.data;
        } else {
            throw new Error('Failed to fetch TURN servers: ' + (response.data?.error || 'Unknown error'));
        }
    } catch (error) {
        throw new Error('Error fetching TURN servers from backend: ' + error.message);
    }
}

module.exports = {
    fetchTurnServersFromBackend
}; 