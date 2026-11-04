# Vectorizador

Sube una imagen (PNG/JPG/WebP/GIF/BMP) y obtén un SVG de alta calidad.

    npm install
    npm start        # http://localhost:3000

Pipeline (`server.js`):

1. **Limpieza** en la resolución de origen (mediana + desenfoque), ampliación Lanczos a 2000–4096 px
   y un desenfoque proporcional a la ampliación.
2. **Paleta** (`lib/palette.js`): k-means sobre una muestra, se descartan los colores de transición
   y los artefactos JPEG, y cada píxel va al color dominante más cercano.
3. **Degradados** (`lib/gradients.js`): las bandas vecinas de tono parecido se fusionan solo si los píxeles
   originales de la unión se explican con un perfil de color lineal; se emite un `linearGradient`.
4. **Trazado** con VTracer (`@neplex/vectorizer`), formas recortadas sin solapes.
5. **Bordes limpios** (`lib/smooth.js`): remuestreo, esquinas, filtro Taubin (sin encoger curvas), rectas exactas
   (alineadas con el eje, esquinas como intersección de rectas, filetes como arco) y
   reajuste con pocas Béziers cúbicas (Schneider). Quita las ondulaciones que deja el raster.
6. **Arcos exactos** (`lib/shapes.js`): los subtrazados que son círculos/elipses se reemplazan por arcos `A`.
7. **Relleno de huecos**: trazo fino del mismo color que cada forma para tapar costuras.
8. **OXVG** optimiza el SVG.

Las imágenes casi monocromas (tinta/línea) se detectan solas y se trazan en blanco y negro.
