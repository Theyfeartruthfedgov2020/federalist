const crypto = require('crypto');
const URLSafeBase64 = require('urlsafe-base64');
const SQS = require('../services/SQS');

const { branchRegex, shaRegex, isEmptyOrUrl } = require('../utils/validators');
const { buildUrl } = require('../utils/build');

const afterCreate = (build) => {
  const {
    Site, User, Build, UserEnvironmentVariable,
  } = build.sequelize.models;

  return Build.findOne({
    where: { id: build.id },
    include: [User, {
      model: Site,
      required: true,
      include: [UserEnvironmentVariable],
    }],
  })
    .then((foundBuild) => {
      Build.count({
        where: { site: foundBuild.site },
      }).then(count => SQS.sendBuildMessage(foundBuild, count));
    });
};

const associate = ({
  Build,
  BuildLog,
  Site,
  User,
}) => {
  Build.hasMany(BuildLog, {
    foreignKey: 'build',
  });
  Build.belongsTo(Site, {
    foreignKey: 'site',
    allowNull: false,
  });
  Build.belongsTo(User, {
    foreignKey: 'user',
    allowNull: false,
  });
};

const generateToken = () => URLSafeBase64.encode(crypto.randomBytes(32));

const beforeValidate = (build) => {
  build.token = build.token || generateToken(); // eslint-disable-line no-param-reassign
};

const sanitizeCompleteJobErrorMessage = message => message.replace(/\/\/(.*)@github/g, '//[token_redacted]@github');

const jobErrorMessage = (message = 'An unknown error occurred') => sanitizeCompleteJobErrorMessage(message);

const jobStateUpdate = (buildStatus, build, site, timestamp) => {
  const atts = {
    state: buildStatus.status,
  };

  if (buildStatus.status === 'error') {
    atts.error = jobErrorMessage(buildStatus.message);
  }

  if (['error', 'success'].includes(buildStatus.status)) {
    atts.completedAt = timestamp;
  }

  if (buildStatus.status === 'success') {
    atts.url = buildUrl(build, site);
  }

  if (build.state === 'queued' && buildStatus.status === 'processing') {
    atts.startedAt = timestamp;
  }

  return build.update(atts);
};

async function updateJobStatus(buildStatus) {
  const timestamp = new Date();
  const site = await this.getSite();
  const build = await jobStateUpdate(buildStatus, this, site, timestamp);
  if (build.state === 'success') {
    await site.update({ publishedAt: timestamp });
  }
  return build;
}

module.exports = (sequelize, DataTypes) => {
  const Build = sequelize.define('Build', {
    branch: {
      type: DataTypes.STRING,
      validate: {
        is: branchRegex,
      },
    },
    commitSha: {
      type: DataTypes.STRING,
      validate: {
        is: shaRegex,
      },
    },
    completedAt: {
      type: DataTypes.DATE,
    },
    error: {
      type: DataTypes.STRING,
    },
    source: {
      type: DataTypes.JSON,
    },
    state: {
      type: DataTypes.ENUM,
      values: ['error', 'processing', 'skipped', 'success', 'queued'],
      defaultValue: 'queued',
      allowNull: false,
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    site: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    user: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    startedAt: {
      type: DataTypes.DATE,
    },
    url: {
      type: DataTypes.STRING,
      validate: isEmptyOrUrl,
    },
  }, {
    tableName: 'build',
    hooks: {
      afterCreate,
      beforeValidate,
    },
    scopes: {
      forSiteUser: (user, Site, User) => ({
        include: [{
          model: Site,
          required: true,
          include: [{
            model: User,
            where: {
              id: user.id,
            },
          }],
        }],
      }),
    },
  });

  Build.generateToken = generateToken;
  Build.associate = associate;
  Build.prototype.updateJobStatus = updateJobStatus;
  return Build;
};
