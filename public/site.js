/* Shared marketing page behavior: scroll-staggered entrances and nav shadow. */
(function () {
  'use strict';

  // fade-in-up on scroll: elements with .sv animate when they enter the viewport
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.sv:not(.in)').forEach(function (el) { io.observe(el); });

  // nav gains a hairline shadow once the page scrolls
  var nav = document.getElementById('nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
