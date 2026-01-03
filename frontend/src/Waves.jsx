import React, { useEffect, useRef } from 'react';

export default function Waves({ paused = false }) {
  const canvasRef = useRef(null);
  const animationRef = useRef();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    const waves = [
      { amplitude: 22, frequency: 0.0045, speed: 0.02, baseHeight: 0.9, offset: 0 },
      { amplitude: 16, frequency: 0.006, speed: 0.015, baseHeight: 0.85, offset: 0 },
      { amplitude: 12, frequency: 0.008, speed: 0.011, baseHeight: 0.8, offset: 0 }
    ];

    const colors = [
      'rgba(255, 255, 255, 0.14)',
      'rgba(255, 255, 255, 0.1)',
      'rgba(255, 255, 255, 0.08)'
    ];

    let time = 0;

    const drawWave = (wave, color) => {
      ctx.beginPath();
      ctx.moveTo(0, canvas.height);

      for (let x = 0; x <= canvas.width; x++) {
        const y = wave.baseHeight * canvas.height +
          wave.amplitude * Math.sin(x * wave.frequency + wave.offset);
        ctx.lineTo(x, y);
      }

      ctx.lineTo(canvas.width, canvas.height);
      ctx.lineTo(0, canvas.height);
      ctx.closePath();

      ctx.fillStyle = color;
      ctx.fill();
    };

    const animate = () => {
      if (!paused) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        waves.forEach((wave, idx) => {
          wave.offset = time * wave.speed;
          drawWave(wave, colors[idx]);
        });
        time += 1;
      }
      animationRef.current = requestAnimationFrame(animate);
    };

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      waves.forEach((wave, idx) => drawWave(wave, colors[idx]));
    } else {
      animate();
    }

    return () => {
      window.removeEventListener('resize', resize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [paused]);

  return <canvas ref={canvasRef} className="waves" aria-hidden="true" />;
}
