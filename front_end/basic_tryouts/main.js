const audio = document.querySelector('audio');
const playbtn = document.querySelector('.play-button');
const pausebtn = document.querySelector('.pause-button');
playbtn.addEventListener('click', () => {
    audio.play();
});

pausebtn.addEventListener('click', () => {
    audio.pause();
});

