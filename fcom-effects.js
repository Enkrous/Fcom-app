'use strict';

(function () {
  function initLoader() {
    const loader = document.getElementById('loader');
    if (!loader) return;
    window.setTimeout(() => {
      loader.classList.add('is-hidden');
    }, 700);
  }

  function initCursorGlow() {
    const glow = document.querySelector('.cursor-glow');
    if (!glow) return;

    window.addEventListener('pointermove', (event) => {
      glow.style.setProperty('--mx', event.clientX + 'px');
      glow.style.setProperty('--my', event.clientY + 'px');
      glow.style.opacity = '1';
    });

    window.addEventListener('pointerleave', () => {
      glow.style.opacity = '0';
    });
  }

  function initParticles() {
    const canvas = document.querySelector('.particle-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const particles = [];
    let animationId = 0;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      seed();
    }

    function seed() {
      particles.length = 0;
      const count = Math.max(36, Math.floor(window.innerWidth / 32));
      for (let i = 0; i < count; i += 1) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          r: Math.random() * 1.6 + 0.6,
          dx: (Math.random() - 0.5) * 0.22,
          dy: (Math.random() - 0.5) * 0.22,
          a: Math.random() * 0.4 + 0.15,
        });
      }
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (const p of particles) {
        p.x += p.dx;
        p.y += p.dy;

        if (p.x < -20) p.x = canvas.width + 20;
        if (p.x > canvas.width + 20) p.x = -20;
        if (p.y < -20) p.y = canvas.height + 20;
        if (p.y > canvas.height + 20) p.y = -20;

        ctx.beginPath();
        ctx.fillStyle = 'rgba(173, 227, 255,' + p.a + ')';
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      animationId = window.requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    draw();

    window.addEventListener('beforeunload', () => {
      window.cancelAnimationFrame(animationId);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initLoader();
    initCursorGlow();
    initParticles();
  });
})();
