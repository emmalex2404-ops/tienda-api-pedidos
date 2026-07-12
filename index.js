const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// ==================== NODEMAILER ====================

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function enviarCorreo(destinatario, asunto, mensaje) {
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: destinatario,
    subject: asunto,
    html: mensaje,
  });
}

// ==================== MIDDLEWARE JWT ====================

function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Token inválido o expirado' });
  }
}

function soloAdminOVendedor(req, res, next) {
  if (![2, 3].includes(req.usuario.role_id))
    return res.status(403).json({ error: 'Acceso solo para vendedores o administradores' });
  next();
}

// ==================== CARRITO ====================

// GET - Ver carrito del usuario
app.get('/carrito', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cart_items WHERE user_id = $1',
      [req.usuario.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST - Agregar producto al carrito
app.post('/carrito', verificarToken, async (req, res) => {
  const { product_id, cantidad } = req.body;
  try {
    const existe = await pool.query(
      'SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2',
      [req.usuario.id, product_id]
    );
    if (existe.rows.length > 0) {
      const result = await pool.query(
        'UPDATE cart_items SET cantidad = cantidad + $1 WHERE user_id = $2 AND product_id = $3 RETURNING *',
        [cantidad, req.usuario.id, product_id]
      );
      return res.json(result.rows[0]);
    }
    const result = await pool.query(
      'INSERT INTO cart_items (user_id, product_id, cantidad) VALUES ($1, $2, $3) RETURNING *',
      [req.usuario.id, product_id, cantidad]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH - Actualizar cantidad en carrito
app.patch('/carrito/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  const { cantidad } = req.body;
  try {
    const result = await pool.query(
      'UPDATE cart_items SET cantidad = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [cantidad, id, req.usuario.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item no encontrado' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE - Eliminar producto del carrito
app.delete('/carrito/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM cart_items WHERE id = $1 AND user_id = $2', [id, req.usuario.id]);
    res.json({ mensaje: 'Producto eliminado del carrito' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PEDIDOS ====================

// POST - Crear pedido desde el carrito
app.post('/pedidos', verificarToken, async (req, res) => {
  const { direccion_envio, items, total } = req.body;
  try {
    const order = await pool.query(
      'INSERT INTO orders (user_id, total, direccion_envio, estatus) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.usuario.id, total, direccion_envio, 'pendiente']
    );
    const orderId = order.rows[0].id;

    for (const item of items) {
      await pool.query(
        'INSERT INTO order_items (order_id, product_id, nombre_producto, precio, cantidad) VALUES ($1, $2, $3, $4, $5)',
        [orderId, item.product_id, item.nombre_producto, item.precio, item.cantidad]
      );
    }

    await pool.query('DELETE FROM cart_items WHERE user_id = $1', [req.usuario.id]);

    // Notificar al admin
    await enviarCorreo(
      process.env.EMAIL_ADMIN,
      `Nuevo pedido #${orderId} recibido`,
      `<h2>Nuevo pedido #${orderId}</h2>
       <p><b>Cliente:</b> ${req.usuario.nombre}</p>
       <p><b>Total:</b> $${total}</p>
       <p><b>Dirección:</b> ${direccion_envio}</p>`
    );

    res.json({ mensaje: 'Pedido creado', pedido: order.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET - Ver mis pedidos (cliente)
app.get('/pedidos/mis-pedidos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
      [req.usuario.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET - Ver todos los pedidos (admin/vendedor)
app.get('/pedidos', verificarToken, soloAdminOVendedor, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET - Ver detalle de un pedido
app.get('/pedidos/:id', verificarToken, async (req, res) => {
  const { id } = req.params;
  try {
    const order = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [id]);
    if (order.rows.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ pedido: order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH - Actualizar estatus del pedido (admin/vendedor)
app.patch('/pedidos/:id/estatus', verificarToken, soloAdminOVendedor, async (req, res) => {
  const { id } = req.params;
  const { estatus, numero_guia } = req.body;
  const estatusValidos = ['pendiente', 'pagado', 'en preparacion', 'enviado', 'entregado', 'cancelado'];
  if (!estatusValidos.includes(estatus))
    return res.status(400).json({ error: 'Estatus inválido' });
  try {
    const result = await pool.query(
      'UPDATE orders SET estatus = $1, numero_guia = $2 WHERE id = $3 RETURNING *',
      [estatus, numero_guia || null, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });

    const pedido = result.rows[0];

    // Notificar al cliente
    await enviarCorreo(
      process.env.EMAIL_USER,
      `Tu pedido #${id} fue actualizado`,
      `<h2>Actualización de tu pedido #${id}</h2>
       <p>El estatus de tu pedido cambió a: <b>${estatus}</b></p>
       ${numero_guia ? `<p><b>Número de guía:</b> ${numero_guia}</p>` : ''}
       <p>Gracias por tu compra.</p>`
    );

    res.json({ mensaje: 'Estatus actualizado', pedido });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`API Pedidos corriendo en http://localhost:${PORT}`);
});
