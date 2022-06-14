CREATE DATABASE IF NOT EXISTS cats DEFAULT CHARACTER SET utf8 COLLATE utf8_general_ci;
use cats;
CREATE USER IF NOT EXISTS cats@'localhost' IDENTIFIED BY 'cats';
GRANT ALL PRIVILEGES ON cats.* TO 'cats'@'localhost' IDENTIFIED BY 'cats';
flush privileges;
