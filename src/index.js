const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  log,
  utils,
  errors
} = require('cozy-konnector-libs')
const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is set to false by default
  debug: false,
  // Desactivate [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // Activate JSON parsing
  json: true,
  // This allows request-promise to keep cookies between requests
  jar: true
})
const cheerio = require('cheerio')
const PassThrough = require('stream').PassThrough

const VENDOR = 'dauchez'
const baseUrl = 'https://extranet.dauchez.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  log('info', 'Fetching the list of documents')
  const docList = await getDocumentsList()
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments(docList)
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    // This is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['dauchez'],
    contentType: 'application/pdf'
  })
}

// HTML form uses a JS wrapper, meaning that signin function cannot be used.
// Use a simple POST request instead.
async function authenticate(login, password) {
  try {
    const loginResult = await request(`${baseUrl}/Login`, {
      method: 'POST',
      headers: {
        // Why do we need this header? No idea ¯\_(ツ)_/¯, but it doesn't work without it
        'X-Requested-With': 'XMLHttpRequest'
      },
      form: {
        identifiant: login,
        pwd: password,
        'g-recaptcha-response': '',
        hid_css: '',
        isIframe: 0
      }
    })

    // Check the response
    if (loginResult.response === true && loginResult.flag_login === true) {
      // Follow redirection if any is present
      if (loginResult.redirect) {
        await request(`${baseUrl}${loginResult.redirect}`)
      }
      return true
    }

    log('error', 'Failed to login, response: "' + loginResult.message + '"')
    throw new Error(errors.LOGIN_FAILED)
  } catch (err) {
    log('error', 'Failed to login, error: ' + err.message)
    throw new Error(errors.LOGIN_FAILED)
  }
}

async function getDocumentsList() {
  // First get the account page
  try {
    await request(`${baseUrl}/Extranet/Compte`)
  } catch (err) {
    log('error', 'Failed to retrieve account page, error: ' + err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
  // Then get the situation
  try {
    await request(`${baseUrl}/Extranet/Compte/situation`)
  } catch (err) {
    log('error', 'Failed to retrieve situation page, error: ' + err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
  // Then load the "encart" (whatever it is)
  try {
    await request(`${baseUrl}/Encart/load`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
  } catch (err) {
    log('error', 'Failed to load encart page, error: ' + err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
  // And finally we can get the list of operations (only the rent bills)
  try {
    const docList = await request(`${baseUrl}/Extranet/Compte/listSituation`, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      form: {
        sortCompte: '',
        titleCompte: 'Situation',
        limitCompte: 0,
        nom: '',
        debit: 1,
        id_libelle_code_collectif: 22,
        montant_min: '',
        montant_max: '',
        date_debut: '',
        date_fin: '',
        'id_type_collectif[]': 7
      }
    })
    if (docList.response != true) {
      log(
        'error',
        'Failed to get documents, message: "' + docList.message + '"'
      )
      throw new Error(errors.NOT_EXISTING_DIRECTORY)
    }
    // The content is HTML, convert it to a cheerio object
    return cheerio.load(docList.returnArray.contenu)
  } catch (err) {
    log('error', 'Failed to retrieve list of operations, error: ' + err.message)
    throw new Error(errors.VENDOR_DOWN)
  }
}

// The goal of this function is to parse a HTML page wrapped by a cheerio instance
// and return an array of JS objects which will be saved to the cozy by saveBills
// (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savebills)
async function parseDocuments(docList) {
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const docs = scrape(
    docList,
    {
      date: {
        sel: 'td:nth-child(1)',
        parse: normalizeDate
      },
      title: {
        sel: 'td:nth-child(3)'
      },
      amount: {
        sel: 'td:nth-child(4)',
        parse: normalizePrice
      },
      fileUrl: {
        sel: 'td:nth-child(6)>span>a',
        attr: 'href'
      }
    },
    'table>tbody>tr:not(:first-child):not(:last-child)'
  )

  // Now that we have the possible files, download them
  let finalDocs = []
  for (let doc of docs) {
    if (doc.fileUrl) {
      const filename = `${utils.formatDate(
        doc.date
      )}_${VENDOR}_${doc.amount.toFixed(2)}€${
        doc.vendorRef ? '_' + doc.vendorRef : ''
      }.pdf`
      const filestream = await request(`${baseUrl}${doc.fileUrl}`, {
        cheerio: false,
        json: false
      }).pipe(new PassThrough())

      finalDocs.push({
        ...doc,
        filename,
        filestream,
        currency: '€',
        vendor: VENDOR,
        metadata: {
          // It can be interesting to add the date of import. This is not mandatory but may be
          // useful for debugging or data migration
          importDate: new Date(),
          // Document version, useful for migration after change of document structure
          version: 1
        }
      })
    }
  }
  return finalDocs
}

// Convert a date string to a date
function normalizeDate(date) {
  // String format: dd/mm/yyyy
  return new Date(
    date.slice(6, 10) + '-' + date.slice(3, 5) + '-' + date.slice(0, 2) + 'Z'
  )
}

// Convert a price string to a float
function normalizePrice(price) {
  // Replace ',' by '.' and remove extra white spaces for parseFloat
  return parseFloat(
    price
      .replace(',', '.')
      .replace(/\s/g, '')
      .trim()
  )
}
