const https = require('https');
const http = require('http');

// ==================== CONFIG ====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'tu_token';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const BOT_USERNAME = 'my_food_ihc_bot';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://tu-dominio.com/webhook';

// In-memory store for user sessions
const userSessions = new Map();
const cartItems = new Map();

// ==================== HELPERS ====================
function makeRequest(method, path, data = null, token = null) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.telegram.org',
            path: `/bot${TELEGRAM_BOT_TOKEN}${path}`,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve(body);
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

function backendRequest(method, path, data = null, token = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${BACKEND_URL}${path}`);
        const protocol = url.protocol === 'https:' ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        console.log('options header',options)

        const req = protocol.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function sendMessage(chatId, text, options = {}) {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        ...options,
    };
    return makeRequest('POST', '/sendMessage', payload);
}

async function sendLocation(chatId) {
    const payload = {
        chat_id: chatId,
        text: '📍 Por favor, comparte tu ubicación (donde deseas recibir el pedido)',
        reply_markup: {
            keyboard: [[{ text: '📍 Compartir ubicación', request_location: true }]],
            one_time_keyboard: true,
            resize_keyboard: true,
        },
    };
    return makeRequest('POST', '/sendMessage', payload);
}

async function sendInlineKeyboard(chatId, text, buttons) {
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: buttons,
        },
    };
    return makeRequest('POST', '/sendMessage', payload);
}

function calculateDeliveryPrice(distanceKm, baseFare = 5.0, maxBaseFareRadius = 1.0, pricePerKm = 2.0) {
    if (distanceKm <= maxBaseFareRadius) {
        return baseFare;
    }
    const extraDistance = distanceKm - maxBaseFareRadius;
    return baseFare + extraDistance * pricePerKm;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ==================== HANDLERS ====================
async function handleStart(chatId, firstName) {
    try {
        // Autenticar/obtener customer desde backend
        const authResponse = await backendRequest('POST', '/auth/telegram-login', {
            telegramId: chatId.toString(),
            name: firstName,
            lastName: 'User',
        });
        console.log("auth ",authResponse)
        if (authResponse.status !== 200 && authResponse.status !== 201) {
            await sendMessage(chatId, '❌ Error de autenticación');
            return;
        }


        const accessToken = authResponse.data.access_token;
        const customer = authResponse.data.customer;

        // Guardar sesión con información del customer
        userSessions.set(chatId, {
            state: 'main_menu',
            firstName,
            customerId: customer.id,
            accessToken,
        });
        cartItems.set(chatId, []);

        const text = `¡Hola ${firstName}! 👋\n\nBienvenido a <b>MyFood</b>. Aquí puedes:\n\n✅ Ver productos\n📦 Hacer pedidos\n🚗 Rastrear tu entrega`;

        const buttons = [
            [{ text: '📍 Enviar ubicación', callback_data: 'send_location' }],
            [{ text: '🛍️ Ver productos', callback_data: 'view_products' }],
            [{ text: '🛒 Mi carrito', callback_data: 'view_cart' }],
            [{ text: '📦 Mis pedidos', callback_data: 'view_orders' }],
        ];

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error en handleStart:', error);
        await sendMessage(chatId, '❌ Error al iniciar sesión');
    }
}

async function handleLocation(chatId, lat, lng) {
    const session = userSessions.get(chatId);
    if (!session || !session.accessToken) {
        await sendMessage(chatId, '❌ Sesión expirada. Usa /start');
        return;
    }

    try {
        // Crear dirección en backend
        const addressResponse = await backendRequest(
            'POST',
            '/addresses',
            {
                name: 'Dirección',
                description: 'Ubicación de entrega',
                coordinateX: lat,
                coordinateY: lng,
            },
            session.accessToken
        );
        console.log(addressResponse)

        if (addressResponse.status !== 200 && addressResponse.status !== 201) {
            await sendMessage(chatId, '❌ Error al guardar dirección');
            return;
        }

        const addressId = addressResponse.data.id;

        // Asociar dirección al customer
        const associateResponse = await backendRequest(
            'POST',
            `/customers/${session.customerId}/addresses/${addressId}`,
            {},
            session.accessToken
        );

        if (associateResponse.status !== 201) {
            await sendMessage(chatId, '❌ Error al asociar dirección');
            return;
        }

        // Guardar en sesión
        session.deliveryLocation = { lat, lng };
        session.deliveryAddressId = addressId;
        userSessions.set(chatId, session);

        const text = `✅ Ubicación guardada:\n📍 <code>${lat.toFixed(6)}, ${lng.toFixed(6)}</code>\n\n¿Qué deseas hacer?`;

        const buttons = [
            [{ text: '🛍️ Ver productos', callback_data: 'view_products' }],
            [{ text: '📍 Cambiar ubicación', callback_data: 'send_location' }],
        ];

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error en handleLocation:', error);
        await sendMessage(chatId, '❌ Error al procesar ubicación');
    }
}

async function handleViewProducts(chatId) {
    try {
        const response = await backendRequest('GET', '/products');

        if (response.status !== 200 || !response.data || response.data.length === 0) {
            await sendMessage(chatId, '❌ No hay productos disponibles');
            return;
        }

        let text = '<b>🛍️ Productos disponibles:</b>\n\n';
        const buttons = [];

        response.data.forEach((product, index) => {
            const productText = `${product.name} - $${product.price} ${product.currency}\n<i>${product.description}</i>`;
            text += `${index + 1}. ${productText}\n\n`;

            buttons.push([
                {
                    text: `➕ ${product.name}`,
                    callback_data: `add_to_cart_${product.id}`,
                },
            ]);
        });

        buttons.push([{ text: '🛒 Ver carrito', callback_data: 'view_cart' }]);

        const session = userSessions.get(chatId);
        session.state = 'viewing_products';
        session.products = response.data;
        userSessions.set(chatId, session);

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error fetching products:', error);
        await sendMessage(chatId, '❌ Error al obtener productos');
    }
}

async function handleAddToCart(chatId, productId) {
    const session = userSessions.get(chatId);
    if (!session || !session.products) {
        await sendMessage(chatId, '❌ Primero debes ver los productos');
        return;
    }

    const product = session.products.find((p) => p.id === parseInt(productId));
    if (!product) {
        await sendMessage(chatId, '❌ Producto no encontrado');
        return;
    }

    const cart = cartItems.get(chatId) || [];
    const existingItem = cart.find((item) => item.id === product.id);

    if (existingItem) {
        existingItem.quantity += 1;
    } else {
        cart.push({ ...product, quantity: 1 });
    }

    cartItems.set(chatId, cart);
    await sendMessage(chatId, `✅ <b>${product.name}</b> agregado al carrito`);
}

async function handleViewCart(chatId) {
    const cart = cartItems.get(chatId) || [];

    if (cart.length === 0) {
        await sendMessage(chatId, '🛒 Tu carrito está vacío');
        return;
    }

    const session = userSessions.get(chatId);
    if (!session || !session.deliveryLocation) {
        await sendMessage(chatId, '❌ Debes compartir tu ubicación primero');
        return;
    }

    let text = '<b>🛒 Tu carrito:</b>\n\n';
    let subtotal = 0;

    cart.forEach((item, index) => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        text += `${index + 1}. ${item.name} x${item.quantity} = $${itemTotal.toFixed(2)}\n`;
    });

    const restaurantLat = parseFloat(process.env.RESTAURANT_LAT || '-16.389385');
    const restaurantLng = parseFloat(process.env.RESTAURANT_LNG || '-68.119294');

    const distance = calculateDistance(
        restaurantLat,
        restaurantLng,
        session.deliveryLocation.lat,
        session.deliveryLocation.lng
    );

    const deliveryPrice = calculateDeliveryPrice(distance);
    const total = subtotal + deliveryPrice;

    text += `\n<b>Subtotal:</b> $${subtotal.toFixed(2)}`;
    text += `\n<b>Distancia:</b> ${distance.toFixed(2)} km`;
    text += `\n<b>Entrega:</b> $${deliveryPrice.toFixed(2)}`;
    text += `\n<b>Total:</b> $${total.toFixed(2)}`;

    session.currentOrder = {
        subtotal,
        distance,
        deliveryPrice,
        total,
    };
    userSessions.set(chatId, session);

    const buttons = [
        [{ text: '✅ Confirmar pedido', callback_data: 'confirm_order' }],
        [{ text: '➕ Agregar más', callback_data: 'view_products' }],
        [{ text: '🗑️ Vaciar carrito', callback_data: 'clear_cart' }],
    ];

    await sendInlineKeyboard(chatId, text, buttons);
}

async function handleConfirmOrder(chatId) {
    const session = userSessions.get(chatId);
    const cart = cartItems.get(chatId) || [];

    if (!session || !session.deliveryAddressId || cart.length === 0) {
        await sendMessage(chatId, '❌ Carrito incompleto o dirección no establecida');
        return;
    }

    try {
        const orderPayload = {
            customerId: session.customerId,
            addressId: session.deliveryAddressId,
            deliveryPrice: session.currentOrder.deliveryPrice,
            products: cart.map((item) => ({
                productId: item.id,
                quantity: item.quantity,
            })),
        };

        const orderResponse = await backendRequest('POST', '/orders', orderPayload, session.accessToken);
        console.log(orderResponse)
        if (orderResponse.status !== 201) {
            await sendMessage(chatId, '❌ Error al crear pedido');
            return;
        }

        const orderId = orderResponse.data.id;
        const text = `✅ <b>¡Pedido confirmado!</b>\n\n📦 ID del pedido: <code>${orderId}</code>\n💰 Total: $${session.currentOrder.total.toFixed(2)}\n\nRastreando tu entrega...`;

        session.lastOrderId = orderId;
        userSessions.set(chatId, session);
        cartItems.set(chatId, []);

        const buttons = [[{ text: '🚗 Rastrear entrega', callback_data: `track_order_${orderId}` }]];

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error confirming order:', error);
        await sendMessage(chatId, '❌ Error al confirmar el pedido');
    }
}

async function handleViewOrders(chatId) {
    const session = userSessions.get(chatId);

    if (!session || !session.accessToken) {
        await sendMessage(chatId, '❌ No tienes sesión activa');
        return;
    }

    try {
        const response = await backendRequest('GET', `/orders/customer/${session.customerId}`, null, session.accessToken);

        if (response.status !== 200 || !response.data || response.data.length === 0) {
            await sendMessage(chatId, '❌ No hay pedidos');
            return;
        }

        let text = '<b>📦 Tus pedidos:</b>\n\n';
        const buttons = [];

        response.data.slice(0, 5).forEach((order) => {
            text += `ID: <code>${order.id}</code>\n`;
            text += `Estado: ${order.orderStatus?.name || 'Desconocido'}\n`;
            text += `Total: $${order.total}\n`;
            text += `Fecha: ${new Date(order.date).toLocaleDateString('es-ES')}\n\n`;

            buttons.push([
                {
                    text: `📦 Pedido #${order.id}`,
                    callback_data: `track_order_${order.id}`,
                },
            ]);
        });

        buttons.push([{ text: '🏠 Ir al inicio', callback_data: 'back_to_menu' }]);

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error fetching orders:', error);
        await sendMessage(chatId, '❌ Error al obtener pedidos');
    }
}

async function handleClearCart(chatId) {
    cartItems.set(chatId, []);
    await sendMessage(chatId, '🗑️ Carrito vaciado');
    const session = userSessions.get(chatId);
    await handleStart(chatId, session?.firstName || 'Usuario');
}

async function handleBackToMenu(chatId) {
    const session = userSessions.get(chatId);
    await handleStart(chatId, session?.firstName || 'Usuario');
}

async function handleTrackOrder(chatId, orderId) {
    const session = userSessions.get(chatId);

    if (!session || !session.accessToken) {
        await sendMessage(chatId, '❌ Sesión expirada');
        return;
    }

    try {
        const orderResponse = await backendRequest(
            'GET',
            `/orders/${orderId}`,
            null,
            session.accessToken
        );

        if (orderResponse.status !== 200) {
            await sendMessage(chatId, '❌ Pedido no encontrado');
            return;
        }

        const order = orderResponse.data;
        let text = `<b>📦 Pedido #${order.id}</b>\n\n`;
        text += `Estado: <b>${order.orderStatus?.name || 'Procesando'}</b>\n`;
        text += `Total: $${order.total}\n`;

        if (order.deliveries && order.deliveries.length > 0) {
            const delivery = order.deliveries[0];
            if (delivery.driver) {
                text += `\n<b>🚗 Conductor:</b>\n`;
                text += `Nombre: ${delivery.driver.name} ${delivery.driver.lastName}\n`;
                text += `Estado: ${delivery.driver.isAvailable ? '✅ Disponible' : '❌ No disponible'}\n`;
            }
        }
console.log('Order ',order)
        text += `\n📍 <b>Tu ubicación:</b> ${order.address?.coordinateX?.toFixed(6)}, ${order.address?.coordinateY?.toFixed(6)}`;

        const buttons = [
            [{ text: '🔄 Actualizar', callback_data: `track_order_${orderId}` }],
            [{ text: '📦 Ver pedidos', callback_data: 'view_orders' }],
        ];

        await sendInlineKeyboard(chatId, text, buttons);
    } catch (error) {
        console.error('Error tracking order:', error);
        await sendMessage(chatId, '❌ Error al rastrear pedido');
    }
}

// ==================== WEBHOOK HANDLER ====================
async function handleUpdate(update) {
    const chatId = update.message?.chat?.id || update.callback_query?.from?.id;

    if (!chatId) return;

    if (update.message) {
        const message = update.message;

        if (message.text === '/start') {
            await handleStart(chatId, message.from.first_name);
        }
    }

    if (update.message?.location) {
        const { latitude, longitude } = update.message.location;
        await handleLocation(chatId, latitude, longitude);
    }

    if (update.callback_query) {
        const data = update.callback_query.data;

        if (data === 'send_location') {
            await sendLocation(chatId);
        } else if (data === 'view_products') {
            await handleViewProducts(chatId);
        } else if (data === 'view_cart') {
            await handleViewCart(chatId);
        } else if (data.startsWith('add_to_cart_')) {
            const productId = data.replace('add_to_cart_', '');
            await handleAddToCart(chatId, productId);
        } else if (data === 'confirm_order') {
            await handleConfirmOrder(chatId);
        } else if (data === 'view_orders') {
            await handleViewOrders(chatId);
        } else if (data === 'clear_cart') {
            await handleClearCart(chatId);
        } else if (data === 'back_to_menu') {
            await handleBackToMenu(chatId);
        } else if (data.startsWith('track_order_')) {
            const orderId = data.replace('track_order_', '');
            await handleTrackOrder(chatId, orderId);
        }

        await makeRequest('POST', '/answerCallbackQuery', {
            callback_query_id: update.callback_query.id,
        });
    }
}

// ==================== SERVER ====================
const port = process.env.PORT || 3001;

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const update = JSON.parse(body);
                await handleUpdate(update);
            } catch (error) {
                console.error('Error processing update:', error);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
    } else if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(port, () => {
    console.log(`Bot server running on port ${port}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}`);

    makeRequest('POST', '/setWebhook', {
        url: WEBHOOK_URL,
        allowed_updates: ['message', 'callback_query'],
    }).then((result) => {
        if (result.ok) {
            console.log('✅ Webhook set successfully');
        } else {
            console.error('❌ Failed to set webhook:', result);
        }
    });
});