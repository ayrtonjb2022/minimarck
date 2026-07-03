# Lista de Rutas - MiniMarck2 API

## Base URL: `http://localhost:3000/api`

---

## 🔐 Autenticación

| Método | Ruta                    | Descripción                                |
| ------ | ----------------------- | ------------------------------------------ |
| POST   | `/auth/register`        | Registrar nuevo usuario con negocio y plan |
| POST   | `/auth/login`           | Iniciar sesión                             |
| GET    | `/auth/me`              | Obtener perfil del usuario autenticado     |
| PUT    | `/auth/change-password` | Cambiar contraseña                         |

---

## 📁 Categorías

| Método | Ruta              | Descripción                 |
| ------ | ----------------- | --------------------------- |
| GET    | `/categorias`     | Listar todas las categorías |
| GET    | `/categorias/:id` | Obtener categoría por ID    |
| POST   | `/categorias`     | Crear nueva categoría       |
| PUT    | `/categorias/:id` | Actualizar categoría        |
| DELETE | `/categorias/:id` | Eliminar categoría          |

---

## 📦 Productos

| Método | Ruta             | Descripción                |
| ------ | ---------------- | -------------------------- |
| GET    | `/productos`     | Listar todos los productos |
| GET    | `/productos/:id` | Obtener producto por ID    |
| POST   | `/productos`     | Crear nuevo producto       |
| PUT    | `/productos/:id` | Actualizar producto        |
| DELETE | `/productos/:id` | Eliminar producto          |

---

## 💰 Ventas

| Método | Ruta          | Descripción             |
| ------ | ------------- | ----------------------- |
| POST   | `/ventas`     | Registrar nueva venta   |
| GET    | `/ventas`     | Listar todas las ventas |
| GET    | `/ventas/:id` | Obtener venta por ID    |

---

## 🧾 Caja

| Método | Ruta                | Descripción            |
| ------ | ------------------- | ---------------------- |
| POST   | `/cajas/apertura`   | Abrir caja             |
| PUT    | `/cajas/cierre/:id` | Cerrar caja            |
| GET    | `/cajas/activa`     | Obtener caja activa    |
| GET    | `/cajas`            | Listar todas las cajas |
| GET    | `/cajas/:id`        | Obtener caja por ID    |

---

## 💵 Movimientos de Caja

| Método | Ruta                           | Descripción                    |
| ------ | ------------------------------ | ------------------------------ |
| POST   | `/movimientos`                 | Registrar ingreso/egreso       |
| GET    | `/movimientos/caja/:cajaId`    | Listar movimientos de una caja |
| GET    | `/movimientos/resumen/:cajaId` | Resumen de movimientos         |

---

## 👥 Clientes Deudores

| Método | Ruta                  | Descripción                   |
| ------ | --------------------- | ----------------------------- |
| GET    | `/deudores`           | Listar todos los deudores     |
| POST   | `/deudores`           | Crear nuevo deudor            |
| GET    | `/deudores/:id`       | Obtener deudor por ID         |
| PUT    | `/deudores/:id`       | Actualizar deudor             |
| DELETE | `/deudores/:id`       | Eliminar deudor               |
| POST   | `/deudores/:id/pagos` | Registrar pago de deudor      |
| GET    | `/deudores/:id/pagos` | Historial de pagos del deudor |

---

## 🏢 Proveedores

| Método | Ruta               | Descripción                  |
| ------ | ------------------ | ---------------------------- |
| GET    | `/proveedores`     | Listar todos los proveedores |
| GET    | `/proveedores/:id` | Obtener proveedor por ID     |
| POST   | `/proveedores`     | Crear nuevo proveedor        |
| PUT    | `/proveedores/:id` | Actualizar proveedor         |
| DELETE | `/proveedores/:id` | Eliminar proveedor           |

---

## 🛒 Compras

| Método | Ruta                    | Descripción              |
| ------ | ----------------------- | ------------------------ |
| POST   | `/compras`              | Registrar nueva compra   |
| GET    | `/compras`              | Listar todas las compras |
| GET    | `/compras/:id`          | Obtener compra por ID    |
| PUT    | `/compras/:id`          | Actualizar compra        |
| PUT    | `/compras/:id/cancelar` | Cancelar compra          |

---

## 📊 Dashboard

| Método | Ruta               | Descripción              |
| ------ | ------------------ | ------------------------ |
| GET    | `/dashboard/stats` | Estadísticas del negocio |

### Parámetros opcionales:

- `?periodo=semana` - Estadísticas de la semana
- `?periodo=dia` - Estadísticas del día

---

## 📈 Reportes

| Método | Ruta                               | Descripción                |
| ------ | ---------------------------------- | -------------------------- |
| GET    | `/reportes/ventas`                 | Reporte de ventas          |
| GET    | `/reportes/productos-mas-vendidos` | Productos más vendidos     |
| GET    | `/reportes/caja/:cajaId`           | Reporte de caja específica |

---

## 👤 Usuarios

| Método | Ruta         | Descripción                         |
| ------ | ------------ | ----------------------------------- |
| GET    | `/users`     | Listar usuarios (solo admin)        |
| GET    | `/users/:id` | Obtener usuario por ID (solo admin) |

---

## 📋 Suscripción

| Método | Ruta                    | Descripción                            |
| ------ | ----------------------- | -------------------------------------- |
| GET    | `/suscripciones/actual` | Obtener suscripción actual del negocio |
| POST   | `/suscripciones`        | Cambiar plan de suscripción            |
| GET    | `/suscripciones/planes` | Listar todos los planes disponibles    |

---

## ❤️ Health Check

| Método | Ruta      | Descripción                |
| ------ | --------- | -------------------------- |
| GET    | `/health` | Verificar estado de la API |

---

## 📝 Notas importantes

- Todas las rutas (excepto `/auth/register` y `/auth/login`) requieren **token JWT** en el header:

  ```
  Authorization: Bearer <token>
  ```

- **Roles disponibles:**
  - `admin`: Acceso total a todos los negocios (solo soporte)
  - `usuario`: Dueño del negocio, acceso según plan contratado

- **El usuario no puede crear otros usuarios**, cada negocio tiene un único usuario dueño.

- **Las funcionalidades disponibles dependen del plan de suscripción** contratado.
