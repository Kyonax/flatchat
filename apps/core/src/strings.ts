// SPDX-License-Identifier: AGPL-3.0-or-later
// Every word the core's pages show, in English and Spanish (Q-H2). A test keeps the two in step.

export type Lang = 'en' | 'es';

export const LANGS: readonly Lang[] = ['en', 'es'];

const en = {
  htmlTitle: 'FlatChat',
  signinTitle: 'Sign in to FlatChat',
  signinLead: 'You are signing in to the FlatChat app on this computer. If you did not start this from the app, close this page.',
  email: 'Email',
  password: 'Password',
  signin: 'Sign in',
  signinWrong: 'That email and password do not match an account.',
  signinSuspended: 'This account is suspended.',
  signinBanned: 'This account is banned.',
  tooMany: 'Too many tries. Wait a minute and try again.',
  requestGone: 'This sign-in page has expired or was already used. Start again from the FlatChat app.',
  signedInTitle: 'Signed in',
  signedIn: 'You are signed in. Go back to the FlatChat app.',
  signupTitle: 'Create your FlatChat account',
  signupLead: 'You were invited to try FlatChat. Others see your display name; your email and birth date stay private.',
  displayName: 'Display name',
  displayNameHint: '3 to 32 letters or numbers, with spaces, dots, dashes or underscores between them.',
  passwordHint: 'At least 10 characters.',
  birth: 'Birth month and year',
  month: 'Month',
  year: 'Year',
  country: 'Country',
  chooseCountry: 'Choose your country',
  consent: 'I have read the privacy notice and I authorize the processing of my data as it describes.',
  privacyLink: 'Read the privacy notice',
  create: 'Create account',
  createdTitle: 'Your account is ready',
  created: 'Go back to the FlatChat app and sign in with your email and password.',
  refusedTitle: 'Account not created',
  refused: 'We cannot create an account for you right now.',
  invitationTitle: 'Invitation',
  problems: {
    'invitation-unknown': 'This invitation link is not valid.',
    'invitation-used': 'This invitation was already used.',
    'invitation-expired': 'This invitation has expired. Ask for a new one.',
    'invitation-refused': 'This invitation can no longer be used.',
    'invitation-email': 'This invitation was made for another email address.',
    email: 'Enter one valid email address.',
    'email-taken': 'An account with this email already exists. Sign in from the FlatChat app instead.',
    'password-short': 'The password needs at least 10 characters.',
    'password-long': 'The password can have at most 256 characters.',
    'display-name': 'The display name needs 3 to 32 letters or numbers, with spaces, dots, dashes or underscores only between them.',
    birth: 'Choose your birth month and enter your birth year.',
    country: 'Choose your country.',
    consent: 'To create an account, you need to accept the privacy notice.',
    age: 'We cannot create an account for you right now.',
  },
  privacyTitle: 'Privacy notice',
  privacy: [
    'FlatChat is a social world platform in a closed test. {operator} runs this server and is responsible for your data.',
    'What we keep: your email, a hash of your password (never the password itself), your display name, your birth month and year, your country, your sign-in sessions, the worlds you register, and when you accepted this notice.',
    'Why: to run your account, to let you sign in and join worlds, to apply the age rules that protect minors, and to keep the platform safe. Worlds you join receive only your account number, your display name, your trust level, whether your email is verified, how old your account is, and whether you are under 18. They never receive your email or your birth date.',
    'Your rights under Colombian law (Ley 1581 de 2012): to know, update and correct your data, to ask what it is used for, to revoke this authorization and to ask for its deletion, and to complain to the Superintendencia de Industria y Comercio. Write to {contact}.',
    'A full privacy policy will replace this short notice before FlatChat opens to the public.',
  ],
  back: 'Back',
  notFound: 'Page not found.',
  error: 'Something went wrong. Try again in a moment.',
} as const;

type Shape<T> = { [K in keyof T]: T[K] extends string ? string : T[K] extends readonly string[] ? readonly string[] : Shape<T[K]> };

export type Strings = Shape<typeof en>;

const es: Strings = {
  htmlTitle: 'FlatChat',
  signinTitle: 'Inicia sesión en FlatChat',
  signinLead: 'Estás iniciando sesión en la aplicación FlatChat de este computador. Si no empezaste esto desde la aplicación, cierra esta página.',
  email: 'Correo electrónico',
  password: 'Contraseña',
  signin: 'Iniciar sesión',
  signinWrong: 'Ese correo y esa contraseña no corresponden a una cuenta.',
  signinSuspended: 'Esta cuenta está suspendida.',
  signinBanned: 'Esta cuenta está bloqueada.',
  tooMany: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.',
  requestGone: 'Esta página de inicio de sesión expiró o ya se usó. Vuelve a empezar desde la aplicación FlatChat.',
  signedInTitle: 'Sesión iniciada',
  signedIn: 'Iniciaste sesión. Vuelve a la aplicación FlatChat.',
  signupTitle: 'Crea tu cuenta de FlatChat',
  signupLead: 'Te invitaron a probar FlatChat. Los demás ven tu nombre visible; tu correo y tu fecha de nacimiento son privados.',
  displayName: 'Nombre visible',
  displayNameHint: 'De 3 a 32 letras o números, con espacios, puntos, guiones o guiones bajos entre ellos.',
  passwordHint: 'Al menos 10 caracteres.',
  birth: 'Mes y año de nacimiento',
  month: 'Mes',
  year: 'Año',
  country: 'País',
  chooseCountry: 'Elige tu país',
  consent: 'Leí el aviso de privacidad y autorizo el tratamiento de mis datos como allí se describe.',
  privacyLink: 'Leer el aviso de privacidad',
  create: 'Crear cuenta',
  createdTitle: 'Tu cuenta está lista',
  created: 'Vuelve a la aplicación FlatChat e inicia sesión con tu correo y tu contraseña.',
  refusedTitle: 'Cuenta no creada',
  refused: 'Por ahora no podemos crear una cuenta para ti.',
  invitationTitle: 'Invitación',
  problems: {
    'invitation-unknown': 'Este enlace de invitación no es válido.',
    'invitation-used': 'Esta invitación ya se usó.',
    'invitation-expired': 'Esta invitación expiró. Pide una nueva.',
    'invitation-refused': 'Esta invitación ya no se puede usar.',
    'invitation-email': 'Esta invitación se hizo para otro correo electrónico.',
    email: 'Escribe un correo electrónico válido.',
    'email-taken': 'Ya existe una cuenta con este correo. Inicia sesión desde la aplicación FlatChat.',
    'password-short': 'La contraseña necesita al menos 10 caracteres.',
    'password-long': 'La contraseña puede tener como máximo 256 caracteres.',
    'display-name': 'El nombre visible necesita de 3 a 32 letras o números, con espacios, puntos, guiones o guiones bajos solo entre ellos.',
    birth: 'Elige tu mes de nacimiento y escribe tu año de nacimiento.',
    country: 'Elige tu país.',
    consent: 'Para crear una cuenta, necesitas aceptar el aviso de privacidad.',
    age: 'Por ahora no podemos crear una cuenta para ti.',
  },
  privacyTitle: 'Aviso de privacidad',
  privacy: [
    'FlatChat es una plataforma de mundos sociales en prueba cerrada. {operator} opera este servidor y es responsable de tus datos.',
    'Qué guardamos: tu correo, un hash de tu contraseña (nunca la contraseña), tu nombre visible, tu mes y año de nacimiento, tu país, tus sesiones, los mundos que registras y cuándo aceptaste este aviso.',
    'Para qué: para mantener tu cuenta, dejarte iniciar sesión y entrar a mundos, aplicar las reglas de edad que protegen a los menores y mantener segura la plataforma. Los mundos a los que entras reciben solo tu número de cuenta, tu nombre visible, tu nivel de confianza, si tu correo está verificado, la antigüedad de tu cuenta y si eres menor de 18 años. Nunca reciben tu correo ni tu fecha de nacimiento.',
    'Tus derechos según la ley colombiana (Ley 1581 de 2012): conocer, actualizar y rectificar tus datos, preguntar para qué se usan, revocar esta autorización y pedir su supresión, y presentar quejas ante la Superintendencia de Industria y Comercio. Escribe a {contact}.',
    'Una política de privacidad completa reemplazará este aviso corto antes de que FlatChat abra al público.',
  ],
  back: 'Volver',
  notFound: 'Página no encontrada.',
  error: 'Algo salió mal. Inténtalo de nuevo en un momento.',
};

export const STRINGS: Record<Lang, Strings> = { en, es };

/** The page's language: `?lang=` first, then the browser's Accept-Language, then English. */
export function pickLang(query: unknown, acceptLanguage: string | undefined): Lang {
  if (query === 'en' || query === 'es') return query;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase();
    if (tag.startsWith('es')) return 'es';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}
