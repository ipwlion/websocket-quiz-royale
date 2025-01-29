const Joi = require('joi');

const registerSchema = Joi.object({
  username: Joi.string().min(3).max(30).required(),
  password: Joi.string().min(3).required(),
});

const loginSchema = Joi.object({
  username: Joi.string().min(3).max(30).required(),
  password: Joi.string().required(),
});

module.exports = { registerSchema, loginSchema };